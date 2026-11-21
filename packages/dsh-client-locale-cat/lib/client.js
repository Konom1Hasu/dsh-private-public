/**
 * @yg/dsh-client-locale-cat — 浏览器侧
 *
 * 向 dsh-client-locale 注册独立可选语言 zh-x-cat（fallback: zh），
 * 覆写 15 个高频 UI namespace 下 145 条非关键提示、导航入口、步骤完成与友好报错文案。
 * 底层报错码、权限确认弹窗按钮、数值统计与设置页项仍自动回退至 zh -> en。
 */
window.__ModuleLoader__.load({
  id: "@yg/dsh-client-locale-cat",
  factory: () => {
    const LOCALE_ID = "zh-x-cat";
    const LOCALE_LABEL = "中文（猫娘版）";
    const FALLBACK_LOCALE = "zh";

    const DICTS = {
      chat: {
        "chat.deepDiving": "正在竖起耳朵认真想喵...",
        "chat.deepDivingFor": "认真想了 {duration} 喵...",
        "message.think": "小脑袋瓜转一转喵",
        "message.stepProcess.thinking": "竖起耳朵理思路喵...",
        "message.stepProcess.read": "扒拉文件瞅一眼喵...",
        "message.stepProcess.readImage": "凑近屏幕看图喵...",
        "message.stepProcess.write": "挥爪写文件喵...",
        "message.stepProcess.search": "满屋子翻代码喵...",
        "message.stepProcess.edit": "叼着笔改文件喵...",
        "message.stepProcess.commands": "啪啪敲命令喵...",
        "message.stepProcess.code": "跑代码试试看喵...",
        "message.stepProcess.webSearch": "上网翻资料喵...",
        "message.stepProcess.webFetch": "顺着网线抓网页喵...",
        "message.stepProcess.subagents": "吆喝小猫干活喵...",
        "message.stepProcess.plan": "舔爪改计划喵...",
        "message.stepProcess.questions": "歪头等你拍板喵~",
        "message.stepProcess.tools": "挥爪动用小道具喵...",
        "message.stepProcess.done.thinking": "想明白啦喵!",
        "message.stepProcess.done.read": "瞅过文件啦喵",
        "message.stepProcess.done.readImage": "看过图啦喵",
        "message.stepProcess.done.write": "写好文件啦喵",
        "message.stepProcess.done.search": "翻过代码啦喵",
        "message.stepProcess.done.edit": "改好文件啦喵",
        "message.stepProcess.done.commands": "敲过命令啦喵",
        "message.stepProcess.done.code": "跑过代码啦喵",
        "message.stepProcess.done.webSearch": "翻过网页啦喵",
        "message.stepProcess.done.webFetch": "抓过网页啦喵",
        "message.stepProcess.done.subagents": "小猫们都安排妥啦喵~",
        "message.stepProcess.done.plan": "改好计划啦喵",
        "message.stepProcess.done.questions": "问过 YG 啦喵",
        "message.stepProcess.done.tools": "动用过小道具啦喵",
        "message.stepProcess.sharedPrefix": "",
        "message.turnProcess.worked": "搞定啦喵~",
        "message.turnProcess.took": "搞定啦喵，忙活了 ",
        "message.turnProcess.failed": "呜...这下搞砸了喵",
        "message.turnProcess.thoughtForAWhile": "挠头想了一会儿喵",
        "message.turnProcess.toolCalls.one": "挥了 {count} 次爪",
        "message.turnProcess.toolCalls.other": "挥了 {count} 次爪",
        "message.turnProcess.subagents.one": "{count} 只小猫",
        "message.turnProcess.subagents.other": "{count} 只小猫",
        "message.compaction": "记忆塞成小毛球啦喵~",
        "message.compaction.running": "正在把记忆揉成团喵...",
        "message.compaction.completed": "揉紧了 {items} 条记忆（约 {tokens} tokens）喵~",
        "message.think": "挠头琢磨喵",
        "message.retry.active": "再扑上去试一次喵!",
        "message.retry.cancelled": "不重试啦，收爪喵",
        "message.retry.started": "又扑上去试了一回喵",
        "message.retry.scheduled": "蹲好准备再试一次喵...",
        "message.failure.auth": "呜，API 密钥不对劲喵",
        "message.failure.accountSignedOut": "退出 DeepSeek 登录啦，这轮先停爪喵...",
        "message.failure.interrupted": "呜...刚才 dsh 进程中途断掉啦（强退、崩溃或超时），重启后这轮就停在半路喵，没跑完的工具结果未知。",
        "message.failure.accountSignInRequired": "先登一下 DeepSeek 账号喵，顺便看看接口支不支持账号认证~",
        "message.failure.quota": "呜，这边额度见底啦喵...",
        "message.turnError": "呜...这轮翻车了喵",
        "message.maxTokens": "话匣子撞到输出上限啦喵...",
        "message.maxTokens.hint": "话说到一半被截断了喵，前面的都留着呢，发个“继续”本猫接着往下说~",
        "message.stopped": "呜呜，收爪喵...",
        "message.taskStopped": "好啦好啦，不干了喵...",
      },
      conversation: {
        "hero.headline": "今天要本猫干嘛喵~",
        "placeholder.hero": "说说想折腾啥喵~ / 呼出指令，@ 拎文件或会话",
        "placeholder.default": "丢点活过来喵~ / 呼出指令，@ 拎文件或会话",
        "input.stop": "快停爪喵!",
        "input.send.queue": "排着队发喵",
        "input.send.steer": "插个嘴喵!",
        "tool.title.read": "瞄一眼文件",
        "tool.title.readImage": "盯一眼图片",
        "tool.title.write": "落爪写入",
        "tool.title.edit": "改两笔",
        "tool.title.glob": "翻找文件",
        "tool.title.grep": "扒拉内容",
        "tool.title.pwsh": "敲条命令",
        "tool.title.bash": "敲条命令",
        "tool.title.webSearch": "上网扒拉",
        "tool.title.webFetch": "抓个网页",
        "tool.title.generic": "动用小道具",
        "tool.title.subagent": "摇只小猫来",
        "tool.title.listAgents": "点名小猫",
        "tool.title.waitAgent": "蹲小猫回来",
        "tool.title.sendMessage": "递张小纸条",
        "tool.title.interruptAgent": "按住那只猫",
        "tool.title.spawnTeammate": "拉只搭档猫",
        "tool.title.createGoal": "立个小目标",
        "detail.wait.noProgress": "现在没有小猫在跑腿喵~",
        "detail.wait.timeout": "等太久超时啦喵...",
        "image.loadFailed": "呜，图片加载失败了喵，点一下再试试~",
        "image.sendFailed": "呜，图片没发出去喵（{reason}），重新塞进来再试吧~",
        "file.uploadFailed": "呜，上传翻车了喵，点一下重试~",
        "ask.cancelledDetail": "这轮取消啦，没提交回答喵",
        "queue.editFailed": "改不动啦喵，这条消息多半已经发出去了...",
        "queue.removeFailed": "删不掉啦喵，这条消息多半已经发出去了...",
        "queue.steerFailed": "呜，插话没插进去喵，再点一次试试~",
      },
      subagent: {
        "count.total.one": "{count} 只小猫",
        "count.total.other": "{count} 只小猫",
        "count.running.one": "{count} 只小猫正在跑腿喵",
        "count.running.other": "{count} 只小猫正在跑腿喵",
        "loading.label": "正在把小猫喊过来喵...",
        "branch.expand": "展开 {label} 手下的小猫喵",
        "branch.collapse": "收起 {label} 手下的小猫喵",
      },
      job: {
        "count.live.one": "{count} 个后台活儿在跑喵",
        "count.live.other": "{count} 个后台活儿在跑喵",
        "status.failed": "呜，扑街了喵",
      },
      question: {
        "wait.takeTime": "不急，慢慢选喵~",
        "wait.held": "本猫蹲这儿一直等你喵~",
        "wait.countdown": "{seconds} 秒后本猫继续干活喵~",
        "plan.header": "计划写好啦，快瞅瞅喵~",
        "plan.approve": "准了，开干喵!",
        "plan.decline": "哼，驳回喵",
        "plan.discuss": "先改改再说喵",
      },
      approval: {
        "waiting": "竖着耳朵等批示喵...",
      },
      goal: {
        "phase.blocked": "呜，卡壳了喵...",
      },
      feedback: {
        "action.like": "夸夸本猫喵~",
        "action.dislike": "哼，答得不好喵",
      },
      sidebar: {
        "session.new": "开新局喵~",
      },
      workspace: {
        "session.new": "开新局喵~",
        "actions.newSession": "开新局喵~",
        "session.untitled": "还没起名喵",
        "sessions.expand": "展开剩下 {n} 条会话喵",
        "status.subagentsRunning.one": "{n} 只小猫干活中喵",
        "status.subagentsRunning.other": "{n} 只小猫干活中喵",
        "section.workspaces": "猫窝区喵",
        "workspace.add": "添个新猫窝喵",
        "groupBy.workspace": "按猫窝分喵",
      },
      pluginManager: {
        "panel": "小插件箱喵",
        "title": "小插件箱喵",
        "crumbRoot": "小插件箱喵",
        "intro": "挑挑装装各种小道具喵~",
        "loading": "正在翻插件箱喵...",
        "empty": "箱子里还空荡荡的喵~",
        "addPlugin": "塞个新插件喵",
      },
      "schedule.manager": {
        "panel": "定时小闹钟喵",
        "title": "定时小闹钟喵",
        "list.loading": "正在翻小闹钟喵...",
        "list.empty": "还没定过定时活儿喵，在对话里建好的会躺在这儿~",
        "empty.action": "定个新闹钟喵",
      },
      "permission.access": {
        "preset.readOnly": "只许瞅瞅喵",
        "preset.workspaceWrite": "窝里随便改喵",
        "preset.fullAccess": "放爪随便搞喵",
      },
      "settings.permission": {
        "preset.readOnly": "只许瞅瞅喵",
        "preset.workspaceWrite": "窝里随便改喵",
        "preset.fullAccess": "放爪随便搞喵",
      },
      "settings.agentPreset": {
        "presetStandardName": "日常干活喵",
        "presetPtcName": "批量跑腿喵",
        "presetMinimalName": "轻装上阵喵",
        "presetCordisName": "造物主喵",
        "nav": "小猫模式喵",
        "inUse": "新局默认喵",
      },
    };

    const inject = ["locale"];

    function apply(ctx) {
      for (const [ns, dict] of Object.entries(DICTS)) {
        ctx.effect(() => ctx.locale.register(ns, LOCALE_ID, dict));
      }
      ctx.effect(() =>
        ctx.locale.addLanguage({
          id: LOCALE_ID,
          label: LOCALE_LABEL,
          fallback: FALLBACK_LOCALE,
        })
      );
    }

    return { inject, apply };
  },
});
