export const navigationItems = {
  home: { label: 'layout.components.navigation.tabs.home', path: '/' },
  proxies: {
    label: 'layout.components.navigation.tabs.proxies',
    path: '/proxies',
  },
  profiles: {
    label: 'layout.components.navigation.tabs.profiles',
    path: '/profile',
  },
  connections: {
    label: 'layout.components.navigation.tabs.connections',
    path: '/connections',
  },
  rules: { label: 'layout.components.navigation.tabs.rules', path: '/rules' },
  logs: { label: 'layout.components.navigation.tabs.logs', path: '/logs' },
  unlock: {
    label: 'layout.components.navigation.tabs.unlock',
    path: '/unlock',
  },
  settings: {
    label: 'layout.components.navigation.tabs.settings',
    path: '/settings',
  },
  // rClash 新增。放在最后 —— use-nav-menu-order.ts 的 resolveMenuOrder 会把
  // 存下来的排序里没有的 path 按这里的顺序补在末尾,所以老用户升级上来也是排最后。
  denoPush: {
    label: 'layout.components.navigation.tabs.denoPush',
    path: '/deno-push',
  },
} as const
