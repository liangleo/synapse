/// <reference types="vite/client" />

declare global {
  interface Window {
    /** 由服务端提供 index.html 时注入 __PANEL_TOKEN__ 替换而来 */
    PANEL_TOKEN: string
  }
}

export {}
