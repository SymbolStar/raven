export const LOCALES = ["en", "zh-CN"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_STORAGE_KEY = "locale";

export function isLocale(value: string | null | undefined): value is Locale {
  return value != null && (LOCALES as readonly string[]).includes(value);
}

export function detectLocale(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith("zh") ? "zh-CN" : DEFAULT_LOCALE;
}

const messages = {
  en: {
    home: "Home",
    monitor: "Monitor",
    overview: "Overview",
    requests: "Requests",
    models: "Models",
    clients: "Clients",
    sessions: "Sessions",
    providers: "Providers",
    logs: "Logs",
    tools: "Tools",
    serverTools: "Server Tools",
    upstreams: "Upstreams",
    settings: "Settings",
    general: "General",
    proxy: "Proxy",
    connect: "Connect",
    navigation: "Navigation",
    browseDashboard: "Browse raven dashboard pages",
    openNavigation: "Open navigation menu",
    collapseSidebar: "Collapse sidebar",
    expandSidebar: "Expand sidebar",
    signOut: "Sign out",
    localMode: "Local mode",
    toggleTheme: "Toggle theme",
    language: "Language",
    english: "English",
    chinese: "简体中文",
  },
  "zh-CN": {
    home: "首页",
    monitor: "监控",
    overview: "概览",
    requests: "请求",
    models: "模型",
    clients: "客户端",
    sessions: "会话",
    providers: "服务提供商",
    logs: "日志",
    tools: "工具",
    serverTools: "服务端工具",
    upstreams: "上游服务",
    settings: "设置",
    general: "通用",
    proxy: "代理",
    connect: "连接",
    navigation: "导航",
    browseDashboard: "浏览 raven 仪表盘页面",
    openNavigation: "打开导航菜单",
    collapseSidebar: "收起侧栏",
    expandSidebar: "展开侧栏",
    signOut: "退出登录",
    localMode: "本地模式",
    toggleTheme: "切换主题",
    language: "语言",
    english: "English",
    chinese: "简体中文",
  },
} as const;

export type MessageKey = keyof (typeof messages)["en"];

export function translate(locale: Locale, key: MessageKey): string {
  return messages[locale][key];
}
