// 游戏开发角色预设：纯数据模块（零依赖），供插件、mock-server、mock-host 共同 import。
export interface ToolRestrictConfig {
  allow?: string[] // 只保留这些全局工具
  deny?: string[] // 屏蔽这些全局工具
}

export interface RoleConfig {
  provider?: string // 模型 provider；省略时继承部署默认路由（推荐，避免硬编码路由名）
  model?: string // 模型 id；省略时同上
  label?: string // 中文名：界面显示用
  prompt?: string // 角色提示词：该角色的每条任务消息前都会附加
  toolsRestrict?: ToolRestrictConfig // 只为该 agent 生效的工具白/黑名单（如评审只读）
}
export interface OrchestratorConfig {
  master?: string // 触发编排的目标角色名，默认 'master'
  pipeline?: string[] // 顺序执行的子角色；省略时用所选 preset 的流水线
}

// ---------- 游戏开发内置角色预设（server / client 两套） ----------
export interface RolePreset {
  roles: Record<string, RoleConfig>
  pipeline: string[]
}

export const GAME_PRESETS: Record<string, RolePreset> = {
  // 客户端（玩法向）：设计 → 架构 → 编码 → 关卡 → 评审 → 测试
  client: {
    roles: {
      'game-designer': {
        label: '游戏策划',
        prompt:
          '你是资深游戏策划：拆解玩法需求，输出核心循环、机制规则、数值框架与验收标准，形成设计文档。',
      },
      'game-architect': {
        label: '客户端架构师',
        prompt:
          '你是客户端架构师：基于设计文档设计场景结构、实体与组件划分、帧循环与 UI 状态机，输出技术方案与模块清单。',
      },
      'gameplay-dev': {
        label: '玩法开发',
        prompt: '你是玩法开发者：按技术方案实现机制、交互与数值逻辑，给出关键代码与文件结构。',
      },
      'level-designer': {
        label: '关卡设计师',
        prompt: '你是关卡设计师：依据设计文档产出关卡数据：布局、敌人与道具配置、难度曲线。',
      },
      'code-reviewer': {
        label: '代码评审',
        prompt:
          '你是代码评审者：只读检查代码质量、性能隐患与边界条件，输出通过或打回结论及修改清单。',
      },
      'game-qa': {
        label: '游戏测试',
        prompt: '你是游戏 QA：产出可执行的测试清单与回归项，汇总缺陷报告与风险。',
      },
    },
    pipeline: [
      'game-designer',
      'game-architect',
      'gameplay-dev',
      'level-designer',
      'code-reviewer',
      'game-qa',
    ],
  },
  // 服务端（逻辑向）：系统设计 → 架构 → 编码 → 评审 → 安全 → 测试
  server: {
    roles: {
      'system-designer': {
        label: '系统策划',
        prompt:
          '你是服务器系统设计师：把玩法需求转成服务端逻辑设计：协议与同步策略、数据模型、结算规则。',
      },
      'server-architect': {
        label: '服务端架构师',
        prompt:
          '你是服务端架构师：设计服务拆分、协议定义、存储选型与并发模型，输出技术方案与接口清单。',
      },
      'server-dev': {
        label: '服务端开发',
        prompt: '你是服务端开发者：按架构实现接口、持久化与结算逻辑，给出关键代码与部署要点。',
      },
      'code-reviewer': {
        label: '代码评审',
        prompt: '你是代码评审者：只读检查代码质量、并发安全与性能，输出通过或打回结论及修改清单。',
      },
      'security-reviewer': {
        label: '安全评审',
        prompt: '你是安全评审者：专注防作弊、注入、越权与异常输入，输出风险清单与整改建议。',
      },
      'server-qa': {
        label: '服务端测试',
        prompt: '你是服务端 QA：产出接口测试、边界用例与压测方案，汇总缺陷报告。',
      },
    },
    pipeline: [
      'system-designer',
      'server-architect',
      'server-dev',
      'code-reviewer',
      'security-reviewer',
      'server-qa',
    ],
  },
}
