"""Write the project feedback memo from completed runs and reviewed decisions.

The decision coding below is an explicit editorial synthesis, not a classifier
or an estimate of participant prevalence. Raw answers remain unchanged.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
data = json.loads((ROOT / "all_reviews.json").read_text(encoding="utf-8"))
assert data["finalized"] and data["pending_logical_runs"] == 0
responses = {row["run_id"]: row for row in data["responses"]}

decisions = [
    {
        "id": "D01",
        "theme": "没有提醒，不等于没有需要本人回应的请求",
        "sources": [
            ["cursor__claude-opus-5-5-high__r1", "Q7"],
            ["cursor__claude-sonnet-5-5-high__r3", "Q7"],
            ["codex-gpt-5.6-sol__r3", "Q7"],
        ],
        "finding": "输入未启动、没有远端文字或自动分析关闭，都可能产生表面上安静的界面。此处是模型指出的可能误解，尚非观察到的用户行为。",
        "status": "partially_implemented",
        "change": "接收区常驻显示实际选择/采集状态、最近文字时间及来源、自动分析开关或缺少密钥。等待权限不显示为已经采集。不根据静默时长断言远端一定没有声音。",
        "files": ["meeting-assistant/public/app.js", "meeting-assistant/public/index.html"],
        "verification": "浏览器回归覆盖人工输入、回放、麦克风、混合音频等待、自动分析与缺少密钥状态。实际音频采集效果仍待验证。",
    },
    {
        "id": "D02",
        "theme": "复制、真正发出、回来记录，是三个不同动作",
        "sources": [
            ["cursor__claude-opus-5-5-high__r1", "Q7"],
            ["cursor__gemini-4-argon-high__r1", "Q7"],
            ["codex-gpt-5.6-sol__r2", "Q3"],
        ],
        "finding": "多次切换窗口可能造成漏发或漏记。旧版已在后端分开确认、复制和自报发送；本次改善的是状态的可见性。",
        "status": "implemented",
        "change": "复制后卡片和详情显示“已复制，待本人发送或记录”。再次编辑时说明先前版本已复制、当前稿须重新确认复制；不能将旧版复制记录当成新版已完成。",
        "files": ["meeting-assistant/public/app.js"],
        "verification": "浏览器检查确认状态关窗重开仍在；编辑后禁止按旧确认状态记录发送；剪贴板内容仍为先前版本，需再次复制。",
    },
    {
        "id": "D03",
        "theme": "“你”或不明说话人不能自动等同于当前用户",
        "sources": [
            ["cursor__gemini-4-argon-high__r1", "Q7"],
            ["cursor__gemini-4-argon-high__r3", "Q7"],
            ["cursor__claude-opus-5-5-high__r2", "Q7"],
        ],
        "finding": "混合会议音频不区分说话人，模型可能误认请求对象或擅自填入姓名。",
        "status": "prompt_changed_effect_unverified",
        "change": "系统提示明确禁止凭发言顺序、语气或提到姓名推断发言人，不把“你”自动映射到当前用户；要求说明不确定性，用中性称呼并优先澄清。",
        "files": ["meeting-assistant/deepseek.mjs"],
        "verification": "语法检查通过；尚未用真实DeepSeek调用验证此提示是否改善输出，不报告准确率提高。",
    },
    {
        "id": "D04",
        "theme": "忙别的事情时，可能看不到页面上的提醒",
        "sources": [
            ["cursor__claude-opus-5-5-high__r2", "Q7"],
            ["cursor__claude-opus-5-5-high__r3", "Q7"],
            ["cursor__gemini-3.1-pro__r3", "Q7"],
        ],
        "finding": "页面内出现卡片与用户真正注意到它不是同一回事。",
        "status": "guidance_added_notifications_pending",
        "change": "接收区和使用说明明确要求工作时保持助手窗口可见。桌面通知、提示音及后台表现留待实际实现和验证，不能称为已解决。",
        "files": ["meeting-assistant/public/index.html", "meeting-assistant/README.txt"],
        "verification": "核对当前代码未调用桌面通知；文案说明当前边界。没有用户注意力实验。",
    },
    {
        "id": "D05",
        "theme": "反馈容易填写，但需要知道如何交到项目组",
        "sources": [
            ["codex-gpt-5.6-sol__r3", "Q6"],
            ["cursor__claude-opus-5-5-high__r3", "Q6"],
            ["cursor__grok-4.7-high__r2", "Q6"],
            ["cursor__muse-spark-1.3-high__r2", "Q6"],
        ],
        "finding": "有模型建议明确本机保存和交付步骤；Grok r2和Muse r2认为现有入口已够用，不要求增加字段。",
        "status": "existing_flow_retained",
        "change": "保留本轮已实现的简短反馈入口及底部说明：保存在这台电脑、不会自动发给项目组，异地试用需导出交回。未为每个模型建议都加一项必填。",
        "files": ["meeting-assistant/public/feedback.js", "meeting-assistant/public/index.html", "meeting-assistant/feedback.mjs"],
        "verification": "12项反馈界面检查覆盖失败重试、丢失响应、会话重置、导出、互斥操作和窄屏；服务端检查覆盖持久化与版本。产品内未灌入模型答复。",
    },
    {
        "id": "D06",
        "theme": "不能用减少点击数来代替发送事实",
        "sources": [
            ["cursor__gemini-3.1-pro__r1", "Q7"],
            ["cursor__gemini-3.1-pro__r2", "Q7"],
            ["cursor__gemini-3.1-pro__r3", "Q7"],
            ["cursor__gemini-4-argon-high__r3", "Q7"],
        ],
        "finding": "Gemini 3.1三个重复均提出合并复制与标记发送。Argon r3提出复制后视为已处理或标记已复制，二者不能等同。",
        "status": "rejected_in_part",
        "change": "拒绝“复制即已发送/已处理”；采用明确的已复制中间态。实际发送仍由本人在腾讯会议完成，回助手记录也只是本人自报。",
        "files": ["meeting-assistant/public/app.js", "meeting-assistant/server.mjs"],
        "verification": "现有回归确认剪贴板成功才记录复制，发送是独立动作。模型之间同意简化流程，不代表其具体方案正确。",
    },
    {
        "id": "D07",
        "theme": "适合有并行任务、又可能需要本人贡献的会议",
        "sources": [
            ["cursor__claude-opus-5-5-high__r2", "Q2"],
            ["cursor__grok-4.7-high__r2", "Q2"],
            ["codex-gpt-5.6-sol__r2", "Q2"],
            ["codex-gpt-5.6-sol__r3", "Q2"],
        ],
        "finding": "这些答复认为S1可能适用；S2只要会后结果、S3持续共同讨论时，直接查看记录或全程参会可能更合适。条件来自事先给定的情境，不能解释成自然发现的人群偏好。",
        "status": "scope_retained",
        "change": "继续聚焦部分参与，不把目标扩大为任何会议都应使用助手。彩排保留无需工具介入的普通交流片段。",
        "files": ["meeting-assistant/rehearsal/README.txt"],
        "verification": "这是待实际试用检验的适用范围判断，没有测量生产力、漏答率或满意度。",
    },
    {
        "id": "D08",
        "theme": "还需实际使用才能判断的改进",
        "sources": [
            ["cursor__kimi-k3-high__r2", "Q7"],
            ["cursor__gemini-3.1-pro__r2", "Q6"],
            ["codex-gpt-5.6-sol__r2", "Q7"],
        ],
        "finding": "其他建议包括会话持久化、可选问题步骤/提醒编号、附带脱敏原话、分析排队可见性。",
        "status": "deferred",
        "change": "会议记录仍在内存，退出前可导出；反馈本身已持久化。暂不自动收集会议原话，不把文本框能自由描述的问题立即扩展成大量字段。保留真实联调与试用后的优先级判断。",
        "files": ["meeting-assistant/README.txt", "meeting-assistant/public/feedback.js"],
        "verification": "模型建议清单不等于已实现功能。当前发言来源、分析进度、无需回应原因和恢复功能原本已有，不能作为本轮新增成果。",
    },
    {
        "id": "D09",
        "theme": "不确定性不能直接变成“无需及时回应”",
        "sources": [
            ["cursor__composer-2.5__r3", "Q7"],
            ["cursor__composer-2.5__r3", "Q6"],
            ["cursor__glm-5.2-high__r3", "Q7"],
        ],
        "finding": "Composer r3建议低置信时默认“了解即可”，可能压掉真正的请求；它还建议新增“转写/识别”主题，但界面已有“输入或转写”。GLM r3建议仅手动模式，而现有自动分析默认关闭。",
        "status": "rejected_or_already_present",
        "change": "不采用低置信直接降级。保留不确定性与核对原话、澄清的流程；不重复添加已有主题和手动模式。",
        "files": ["meeting-assistant/deepseek.mjs", "meeting-assistant/public/index.html"],
        "verification": "将答复与实际代码逐项核对。尚未校准模型置信度，没有可用于自动降级的实测阈值。",
    },
]

for decision in decisions:
    for run, question in decision["sources"]:
        assert run in responses, run
        assert question in responses[run]["response"]["answers"]

findings = {
    "date": "2026-10-20",
    "source_type": "model_simulation",
    "exposure": "description_only",
    "new_human_participants": 0,
    "analysis_method": "Editorial review of original Q1-Q8 responses against current code; no population estimates or simulated satisfaction scores.",
    "reviewed_input_sha256": data["input_sha256"],
    "planned_logical_runs": data["planned_logical_runs"],
    "valid_runs": data["valid_runs"],
    "total_attempts": data["total_attempts"],
    "app_version_delivered": "0.2.0",
    "updated_app_rereviewed_by_models": False,
    "by_model": data["by_model"],
    "decisions": decisions,
    "limits": [
        "Models received the same frozen text description, not screenshots, a live meeting, or the revised UI.",
        "Independent new sessions do not imply independent human participants or independent training data.",
        "Repeated themes can be induced by the same supplied facts and questions.",
        "Codex did not report a runtime model identifier; preserve requested model and this limitation.",
        "No real DeepSeek, remote audio, or user-effect test was performed in this review batch.",
    ],
}
(ROOT / "findings.json").write_text(json.dumps(findings, ensure_ascii=False, indent=2), encoding="utf-8")

model_rows = "\n".join(
    f"{m['provider']:7s} {m['requested_model']:30s} {m['valid_runs']}/{m['planned']} 有效"
    for m in data["by_model"]
)
decision_text = "\n\n".join(
    f"{d['id']}  {d['theme']}\n"
    f"反馈：{d['finding']}\n"
    f"处理：{d['change']}\n"
    f"核验：{d['verification']}\n"
    f"依据：{'; '.join(run + ' / ' + q for run, q in d['sources'])}\n"
    f"文件：{', '.join(d['files'])}"
    for d in decisions
)
memo = f"""会议助手初版反馈与改进记录
日期：2026-10-20；交付版本：0.2.0

本次完成
1. 新增“使用反馈”入口、失败重试、本机持久保存和导出。
2. 完成{data['completed_logical_runs']}个计划评审位置，得到{data['valid_runs']}份通过结构校验的答复；
   {data['failed_or_excluded_logical_runs']}个位置最终未通过，原始失败保留。
3. 核对建议后，补充接收状态、复制后状态，以及不明说话人/对象的澄清提示。

怎么收集
10个模型配置，各安排3次全新会话。共{data['total_attempts']}次进程尝试（包含启动失败与重试），
不是{data['total_attempts']}份答复。有效答复使用{data['unique_valid_session_ids']}个不重复会话，工具调用事件为0，
输入均为同一冻结说明，SHA256：{data['input_sha256']}。
模型没有实际操作界面、参加会议或听音频；本轮新增真人参与者为0。
三个重复用于观察同一说明下意见的稳定性，不求“平均满意度”，不把次数换算成人数。

运行覆盖
{model_rows}
Cursor覆盖已足够，未追加Workbuddy。名称按请求及CLI记录保存；Codex事件未回报实际模型标识。
详细失败、重试、输入哈希与会话检查见run_quality_summary.txt/json和all_reviews.json。

通俗理解这些反馈
最主要的疑虑是：助手是否真的收到了会议内容？我复制完是否已经回复了？
用户忙另一项任务时能否注意到提醒？不明的“你”到底是在问谁？
这些是从说明中提出的待验证问题，不是已经观察到的真实使用结果。
反馈也存在分歧：有模型希望表单附更多原话，有模型认为现有入口就够了；
有模型反复建议复制后标记已发送，这个建议即使多次出现也不正确。

逐项处理
{decision_text}

功能核验
后端与音频边界共25项自动检查通过；主界面18项浏览器检查通过；
反馈界面12项浏览器检查通过。浏览器数据为明确标注的测试数据，未混入生产反馈。
deepseek.mjs语法检查通过。服务已启动并验证版本0.2.0；真实Key尚未配置。
本轮测试未调用真实DeepSeek、未测远端声音识别，没有测“提醒是否提高效率”。
更新后的界面没有再次提交给模型，不能说这些模型已认可改版。

下一轮怎样收集实际评论
先完成组员真实会议的输入、分析、本人发送、对方回应这一整条流程。
让试用者指出一次具体经历：哪句应提醒、哪次不需要、哪里仍看不懂或要多操作。
请其自己选择实际操作过/看过演示/只看说明，并填写希望怎样改；评分可留空。
同一电脑收集后直接导出；异地电脑需导出并交回项目组，当前不自动远程汇集。
优先核对真实声音有没有收全、提醒有没有被注意、跨窗口是否漏发；再决定后续功能。

向老师说明时可以这样说
“根据上次建议，我们给会议助手加了使用反馈入口，并先进行了多模型独立走查。
走查提醒我们重点检查两处：系统到底有没有收到内容，以及复制回复之后有没有真正发出。
因此现在界面持续显示接收和分析状态，复制后也保留待发送提示；对象不清楚时要求先澄清。
接下来用真实会议试用和具体反馈检查这些设计是否有帮助。”

文件入口
all_reviews.json：合并答复、逻辑运行与逐次尝试。
raw/：完整输入、原始输出和运行元数据。
findings.json：可追溯的反馈—修改—核验记录。
../../meeting-assistant/README.txt：启动、密钥、反馈保存与导出说明。
../../meeting-assistant/rehearsal/Narration_zh.txt：已加15秒反馈入口讲解。
"""
(ROOT / "findings_zh.txt").write_text(memo, encoding="utf-8")
print(json.dumps({"valid_runs": data["valid_runs"], "decisions": len(decisions),
                  "outputs": ["findings.json", "findings_zh.txt"]}, ensure_ascii=False))
