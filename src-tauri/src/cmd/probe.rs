//! 探针内核:**另起一个 mihomo 进程**专门测免费节点,不碰正在服务的那个。
//!
//! ## 为什么要独立进程
//!
//! `delayProxyByName` 走的是 mihomo 的 `/proxies/{name}/delay`,只能测**配置里已经
//! 加载的节点**。免费池不在用户的订阅里,想测就得先让某个内核认识它们。
//!
//! 一开始的想法是往运行中的配置里注入(`proxies` 类型的 profile + `enhance_profiles`
//! 重载)。那条路能走通,但代价不小:要重载内核(现有连接会断)、被注入的节点会被
//! `enhance/seq.rs` 塞进第一个 selector 策略组(在代理列表里冒出一堆没用的条目)、
//! 而且测到一半崩了的话得有人负责把配置清干净。
//!
//! 独立进程把这些代价全免了:**主内核一个字节都不动**。探针跑在自己的配置、自己的
//! 端口上,测完杀掉,出什么事都影响不到正在用的连接。
//!
//! ## 探针是"聋哑"的
//!
//! 配置里 `mixed-port: 0`(不监听任何代理端口)、没有 `tun`、没有 `external-ui`、
//! 不设系统代理。它对外唯一的口子是本机回环上的 external-controller,而且带随机
//! secret —— 本机上别的程序也驱使不了它。
//!
//! ## 端口
//!
//! 绑 127.0.0.1:0 让系统分配一个空闲端口,记下来再释放,然后写进探针配置。
//! 中间有一小段竞态窗口(别的程序可能刚好抢走),但这是本机短命进程,撞上了
//! 就是探针起不来、报错返回,重来一次即可 —— 比写死端口号安全得多。

use super::CmdResult;
use crate::cmd::StringifyErr as _;
use crate::utils::dirs;
use anyhow::{Context as _, anyhow};
use clash_verge_logging::{Type, logging};
use serde::Serialize;
use std::net::TcpListener;
use std::sync::Mutex;
use tauri_plugin_shell::ShellExt as _;
use tauri_plugin_shell::process::CommandChild;

/// 正在跑的探针进程。同一时刻只允许一个 —— 免费池的测试是串行的一轮一轮来,
/// 允许多个只会让端口和临时文件互相打架。
static PROBE: Mutex<Option<CommandChild>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
pub struct ProbeInfo {
    /// external-controller 的端口,前端拿它拼 http://127.0.0.1:{port}/proxies/...
    pub port: u16,
    /// 访问 controller 要带的 secret
    pub secret: String,
}

fn free_port() -> anyhow::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").context("找不到空闲端口")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn random_secret() -> String {
    // 用 nanoid 而不是自己拼:仓库里已经有这个依赖(见 Cargo.toml),
    // 而且它用的是密码学安全的随机源。
    nanoid::nanoid!(32)
}

/// 探针的工作目录。放 $APPDATA/probe,跟主内核的目录分开 ——
/// 共用的话两个进程会抢同一份缓存文件。
fn probe_dir() -> anyhow::Result<std::path::PathBuf> {
    let dir = dirs::app_home_dir()?.join("probe");
    std::fs::create_dir_all(&dir).context("建不了探针工作目录")?;
    Ok(dir)
}

/// 起探针。`proxies_yaml` 是待测节点的 YAML 片段(`proxies:` 下面那一段的内容)。
///
/// 返回之后**并不保证 controller 已经能应答** —— 前端拿到 port 之后先轮询
/// `/version`,通了再开始测。放在前端做是因为那边有现成的重试和进度上报。
#[tauri::command]
pub async fn probe_start(proxies_yaml: String) -> CmdResult<ProbeInfo> {
    probe_stop().await.ok();

    let port = free_port().stringify_err()?;
    let secret = random_secret();
    let dir = probe_dir().stringify_err()?;
    let cfg_path = dir.join("probe.yaml");

    // 一份最小配置。**刻意不写 tun / mixed-port / external-ui / dns**:
    // 探针只需要能被 controller 驱使着去拨号,多一个监听就多一份跟主内核抢资源的可能。
    let config = format!(
        "mixed-port: 0\n\
         allow-lan: false\n\
         mode: rule\n\
         log-level: warning\n\
         ipv6: false\n\
         external-controller: 127.0.0.1:{port}\n\
         secret: \"{secret}\"\n\
         proxies:\n{proxies_yaml}\n\
         proxy-groups: []\n\
         rules:\n  - MATCH,DIRECT\n"
    );
    std::fs::write(&cfg_path, config)
        .with_context(|| format!("写不了探针配置: {}", cfg_path.display()))
        .stringify_err()?;

    let app = crate::core::handle::Handle::app_handle();
    let core = crate::config::Config::verge()
        .await
        .latest_arc()
        .get_valid_clash_core();
    let dir_str = dirs::path_to_str(&dir).stringify_err()?;
    let cfg_str = dirs::path_to_str(&cfg_path).stringify_err()?;

    let cmd = app
        .shell()
        .sidecar(core.as_str())
        .map_err(|e| anyhow!("找不到内核 {core:?}: {e:#}"))
        .stringify_err()?
        .args(["-d", dir_str, "-f", cfg_str]);

    let (_rx, child) = cmd
        .spawn()
        .map_err(|e| anyhow!("探针内核起不来: {e:#}"))
        .stringify_err()?;

    logging!(info, Type::Core, "探针内核已启动,controller 端口 {}", port);
    *PROBE.lock().unwrap() = Some(child);

    Ok(ProbeInfo { port, secret })
}

/// 杀掉探针。**幂等** —— 没在跑也返回 Ok。
///
/// 前端在 finally 里调它,所以这里绝不能因为"本来就没跑"而报错:那会把真正的
/// 失败原因盖掉,变成一条看不懂的"停止探针失败"。
#[tauri::command]
pub async fn probe_stop() -> CmdResult<()> {
    let child = PROBE.lock().unwrap().take();
    if let Some(child) = child {
        let pid = child.pid();
        match child.kill() {
            Ok(()) => logging!(info, Type::Core, "探针内核已停止 (pid {})", pid),
            // 进程可能自己已经退了(配置有问题、被系统杀掉),那不算错
            Err(e) => logging!(warn, Type::Core, "停探针内核时出错(可能已经退了): {e}"),
        }
    }
    Ok(())
}

/// 探针还在跑吗。前端切页面回来时用它判断要不要收拾残局。
#[tauri::command]
pub async fn probe_running() -> CmdResult<bool> {
    Ok(PROBE.lock().unwrap().is_some())
}

/// 应用退出时兜底:别把探针进程留在系统里。
pub fn kill_probe_on_exit() {
    if let Some(child) = PROBE.lock().unwrap().take() {
        let _ = child.kill();
    }
}
