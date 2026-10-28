# kernel-tracker.github.io 🐧

Linux Kernel 社区动态追踪工具，支持邮件列表和主线代码合入监控。

## ✨ 功能特性

- **多数据源支持**
  - LKML 邮件列表补丁抓取
  - Git 仓库主线代码合入监控
  - 数据源独立存储和展示
- **AI 智能总结**
  - 自动生成补丁摘要
  - 支持自定义摘要提示词
  - 支持 OpenAI 兼容 API
  - 按重要性排序：优先 arm64/x86 架构、性能/功能重构与驱动框架改动；其他架构、bugfix 与具体设备驱动靠后
- **信息展示**
  - 按类型分组展示（Feature/Bugfix/Other）
  - Git 提交统计（新增/删除行数）
  - 移动端适配

## 🛠️ 技术栈

| 类别   | 技术                           |
| ---- | ---------------------------- |
| 前端框架 | Next.js 14 (App Router)      |
| 语言   | TypeScript                   |
| 样式   | Tailwind CSS                 |
| 数据存储 | JSON 文件                      |
| 信息抓取 | Axios + Cheerio + simple-git |
| AI   | OpenAI API (兼容 MiniMax 等)    |

## 📦 安装

```bash
# 克隆项目
git clone https://github.com/zouyipeng/kernel-tracker.github.io.git
cd kernel-tracker.github.io

# 安装前端依赖
npm install

# 安装后端依赖
cd backend && npm install && cd ..
```

## ⚙️ 配置

### 1. 配置 AI 服务

创建 `backend/config.json`：

```json
{
  "openai": {
    "apiKey": "your-api-key",
    "baseURL": "https://api.openai.com/v1",
    "model": "gpt-3.5-turbo",
    "maxTokens": 4096
  }
}
```

### 2. 配置信息源

编辑 `backend/sources-config.json`。其中 `summaryMaxChars` 用于限制每日「今日社区动态」总览的字数（默认 `900`，按渲染后的可见字数计，**含**图标、子系统名等固定开销，不含各子系统详情小节；设得过低会导致兜底截断把每行从中间切断）：

```json
{
  "summaryMaxChars": 900,
  "sources": [
    {
      "name": "Mailing List",
      "type": "lkml",
      "url": "https://lkml.org/",
      "active": true,
      "excludeAuthors": ["kernel test robot"],
      "lkmlDetailConcurrency": 12,
      "lkmlDetailTimeoutMs": 8000
    },
    {
      "name": "Mainline",
      "type": "git",
      "url": "https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git",
      "active": true,
      "gitConfig": {
        "branch": "master",
        "sinceDays": 7,
        "maxCommits": 200,
        "localPath": "/path/to/linux"
      },
      "summaryPrompt": "自定义摘要提示词..."
    }
  ]
}
```

### 动态排序规则

「今日社区动态」总览与各子系统详情按以下优先级从高到低排序（提示词 + 代码兜底双重生效）：

1. **架构**：`arm64`、`x86` 相关改动优先；`riscv`、`powerpc`、`mips`、`s390`、`loongarch`、`arm32` 等其他架构降权。
2. **类型**：性能、功能相关的重构与优化优先；`bugfix` 降权（影响面很大的回归/安全修复除外）。
3. **驱动**：只关注驱动框架层（driver core、OF/ACPI、bus、DMA、PCI core、各子系统 core）的优化与重构；具体型号设备驱动的改动大幅降权，且不进入总览。
4. **影响范围**：改动文件多、触及公共头文件或核心目录的条目适当加权。

排序由 `backend/src/lib/ai.ts` 中的优先级评分计算，规则调整后可运行 `backend/src/scripts/preview-summary.ts` 查看 Top 条目与排序效果。

## 🚀 运行

### 开发模式

```bash
# 终端1：启动前端
npm run dev

# 终端2：抓取数据
cd backend && npm run fetch all
```

### 生产部署

```bash
# 构建前端
npm run build

# 启动静态服务器
npx serve out
```

### GitHub Pages（Project Pages）部署

本项目已支持通过 GitHub Actions 自动发布到 Project Pages（`https://<user>.github.io/<repo>/`）。

1. 确保仓库 Pages Source 设置为 **GitHub Actions**
2. 默认分支推送后，工作流会自动构建并部署 `out` 目录
3. 本仓库工作流将 `NEXT_PUBLIC_BASE_PATH` 设为 `/kernel-tracker.github.io`，用于适配子路径访问

工作流文件：`.github/workflows/deploy-pages.yml`

### 抓取命令

```bash
cd backend

# 全量抓取所有信息源
npm run fetch -- all

# 查看帮助
npm run fetch -- help
```

## 📁 项目结构

```
kernel-tracker.github.io/
├── backend/
│   ├── src/
│   │   ├── cli/index.ts       # CLI 入口
│   │   └── lib/
│   │       ├── ai.ts          # AI 总结
│   │       ├── fetcher.ts     # 数据抓取
│   │       └── storage.ts     # 存储管理
│   ├── config.json            # AI 配置
│   └── sources-config.json    # 信息源配置
├── public/
│   ├── mailing-list-YYYY-MM-DD.json  # LKML 数据
│   ├── mainline-YYYY-MM-DD.json      # Git 数据
│   ├── source-dates.json             # 日期索引
│   └── serve.json                    # 静态服务配置
├── src/
│   ├── app/
│   │   ├── page.tsx           # 首页
│   │   └── [date]/[source]/   # 动态路由
│   ├── components/
│   │   ├── SourceDashboard.tsx
│   │   └── LKMLPatchCard.tsx
│   └── lib/api.ts
└── README.md
```

## 📡 URL 访问

```
http://localhost:3000                           # 首页
http://localhost:3000/2026-03-25/mailing-list   # LKML 数据
http://localhost:3000/2026-03-25/mainline       # Git 数据
```

## 📄 License

ISC
