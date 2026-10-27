# Meeting Cue

[English](README.md)

AIAA4435「交互式人工智能系统设计与实现」课程项目。
Meeting Cue 支持远程会议中的部分参与：提醒需要本人回应的请求，提供相关上下文，并由本人决定最终回复。

## 启动当前会议助手

需要 **Node.js 22 或更新版本**。服务器仅使用 Node.js 内置模块，无需运行 `npm install`。

1. 克隆本仓库，进入 `meeting-assistant/` 目录。
2. 将 `.env.example` 复制为 `.env`。
3. 在 `.env` 中的 `DEEPSEEK_API_KEY=` 后填写你自己的 DeepSeek API 密钥。示例文件不包含密钥，请勿提交本地 `.env` 文件。
4. Windows 用户双击仓库根目录的 **Open Meeting Cue.cmd**，也可以使用 `meeting-assistant/start.cmd`。
5. 在浏览器中启动会话，填写参与者的职责与限制条件。

也可以在终端中以前台方式运行服务器：

```sh
cd meeting-assistant
node --env-file=.env server.mjs
```

打开 <http://127.0.0.1:8765/>。界面默认使用英文，可通过页头按钮切换为中文。
使用 **Close Meeting Cue.cmd** 关闭 Windows 后台服务。当前会议状态保存在内存中，关闭前请先导出需要保留的会议记录。
修改 `.env` 或后端代码后，需要重启服务。

音频选择、自动分析、录屏和反馈入口的详细说明见
[英文使用说明](meeting-assistant/README.txt)或[中文使用说明](meeting-assistant/README.zh.txt)。

## 已实现的功能

- 在腾讯会议旁边使用的本地浏览器助手。
- 文字输入，以及依赖浏览器支持的语音转写和音频采集。
- 根据参与者角色、职责与限制条件，使用 DeepSeek 分析会议文字。
- 「需要立即回应」「稍后处理」「了解即可」分类，以及来源原文和可编辑的回复草稿。
- 明确的确认与复制状态、由用户标记的发送状态、会话控制和反馈入口。

当前系统不是嵌入腾讯会议的官方插件。回复需要用户手动粘贴并发送到腾讯会议。
浏览器语音识别与 DeepSeek API 是两个独立服务。窗口音频是否可用，取决于浏览器和所选采集源；系统音频模式可能包含其他应用的声音，界面会说明采集范围。
运行分析时，会议文字和用户提供的参与者背景会发送给 DeepSeek。本地反馈和导出的会议记录应经过检查后再公开。

## 仓库内容

- `meeting-assistant/`：当前 AI 会议助手、启动脚本、演练材料与测试。
- `prototype/`：早期离线脚本交互原型，打开 `index.html` 即可使用。
- `research/`：问卷、公开资料、模型模拟回答与评价分析。
- `output/2026-10-23_legacy_demo/`：当前展示材料、三人英文讲稿，以及带英文说明字幕的早期 demo。
- `output/2026-10-23_workflow_review/`：此前围绕当前操作流程评价制作的展示版本。
- `output/proposal/` 与 `remote meeting.md`：研究提案材料。
- `CURRENT_PROJECT_STATUS.txt`：项目历史与当前工作版本说明。

历史导出目录、临时工具、运行日志、本地反馈、密钥文件和无关课程作业不纳入版本控制。部分历史说明会引用这些仅保存在本地的文件。
原始 CLI 标准输出、错误输出和连接探测记录也未上传；评价回答及来源记录仍保留在仓库中。

## 展示视频与研究证据

当前展示使用一段 **64.36 秒的早期脚本原型视频**，演示职责判断、补回上下文和本地回复确认。
视频没有展示实时 DeepSeek 分析、语音转写或向腾讯会议发送消息。
带英文说明字幕的 MP4 与 PPT 分开保存，展示目录中提供了插入视频的说明。幻灯片区分了早期录屏与后来实现的 AI 会议助手。

不同研究阶段的记录单位不同：初始问卷、来自多种来源的 43 条探索性记录、29 份早期描述评价，以及覆盖 11 个模型配置的 32 份有效模拟操作流程评价。
模型评价次数不等于招募的真人数量，也不是对用户生产率的测量。研究记录保留了来源与局限说明。
详见[当前操作流程评价发现](research/current_use_review_2026-10-23/findings_zh.txt)与[分析结果](research/current_use_review_2026-10-23/analysis.json)。

根据评价发现，系统已修改后续分析逻辑，将尚未发送的本地回复与会议事实分开处理。
对打断次数、及时回应和并行任务表现的实际影响，仍有待进一步评估。

## 运行测试

```sh
cd meeting-assistant
node --test test/*.test.mjs
```

完整测试包含 Windows 启动器检查。浏览器和音频行为还需要在真实设备上验证。
早期原型另有测试，在仓库根目录运行：

```sh
node --test prototype/core.test.cjs
```

## 团队

Chi Kit WONG、Haodong XU、Sida ZHANG — Group 3。
