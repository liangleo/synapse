// 按 agentId 稳定生成色相（每张卡片顶部/进度条的颜色）
export const col = (id: string): string => {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360
  return `hsl(${h} 55% 48%)`
}

export const nm = (x: { role?: string; id: string }): string => x.role || x.id.slice(0, 12)

export const hm = (t: number): string => new Date(t).toTimeString().slice(0, 8)
