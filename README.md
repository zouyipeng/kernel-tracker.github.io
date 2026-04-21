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

编辑 `backend/sources-config.json`：

```json
{
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

# 一键部署
npm run all
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

# 为指定信息源重新生成摘要
npm run fetch -- summary --source "Mailing List"
npm run fetch -- summary --source "Mainline" --date 2026-03-25

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
