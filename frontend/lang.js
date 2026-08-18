// Championship Run — Chinese language pack
// Player names, team names, position/stat abbreviations stay in English.

const LANG = {
  // ---- Header ----
  'brand.title': '冠军之路',
  'brand.tagline': 'NBA 阵容构建模拟',
  'nav.home': '首页',

  // ---- Home: quick-action cards ----
  'home.newRun': '开始新游戏',
  'home.newRun.desc': '选择球队、组建阵容、争夺总冠军。',
  'home.save': '存档与备份',
  'home.save.desc': '导出、导入或切换存档。',
  'home.library': '球员库',
  'home.library.desc': '搜索并排序全部球员的评分、数据和位置。',
  'home.matchup': '模拟对战',
  'home.matchup.desc': '组建两支球队进行模拟对决。',
  'home.trophy': '🏆 奖杯陈列室',
  'home.hof': '🏅 名人堂',
  'home.manageSaves': '管理存档…',

  // ---- New Run form ----
  'form.gameMode': '游戏模式',
  'form.normal': '普通',
  'form.normalHint': '（2025-26赛季）',
  'form.dynasty': '王朝',
  'form.dynastyHint': '（最多10个赛季）',
  'form.teamName': '自定义队名',
  'form.teamNameHint': '（选填）',
  'form.teamName.placeholder': '例如：重建者',
  'form.replaceTeam': '替换球队（决定分区）',
  'form.draftMode': '选秀模式',
  'form.open': '公开',
  'form.blind': '盲选',
  'form.difficulty': '难度',
  'form.normalDiff': '普通',
  'form.hard': '困难',
  'form.hardHint': '（$400M 工资帽）',
  'form.startDraft': '开始选秀',
  'form.archive': '赛季存档',

  // ---- Progress bar ----
  'step.draft': '选秀',
  'step.lineup': '阵容',
  'step.season': '赛季',
  'step.playoffs': '季后赛',
  'step.result': '结果',

  // ---- Draft ----
  'draft.title': '选秀',
  'draft.rookieTitle': '新秀选秀',
  'draft.desc': '每轮从5名球员中选1人,直到满10人。',
  'draft.reroll': '重新抽取',
  'draft.picked': '已选',
  'draft.need': '需要',
  'draft.pick': '选择',
  'draft.bigBoard': '选秀大会',
  'draft.yourPick': '你的选秀顺位',
  'draft.picksSoFar': '选秀进行中',

  // ---- Free Agency ----
  'fa.title': '休赛期自由市场',
  'fa.desc': '释放球员腾出名额,然后签约自由球员。或者直接前往阵容设置。',
  'fa.done': '完成 — 前往阵容设置',
  'fa.release': '释放',
  'fa.sign': '签约',
  'fa.contract': '合同',
  'fa.years': '年',

  // ---- Lineup ----
  'lineup.title': '设置首发五人',
  'lineup.desc': '为每个位置分配一名球员。错位球员会受到评分惩罚。',
  'lineup.strength': '球队实力',
  'lineup.updates': '调整首发时实时更新',
  'lineup.confirm': '确认阵容',

  // ---- Season ----
  'season.title': '常规赛',
  'season.simulate': '模拟82场赛季',
  'season.midseason': '赛季中段休息',
  'season.midseasonHelp': '你现在可以调整阵容、进行交易,然后模拟下半赛季。',
  'season.adjustLineup': '🎯 调整阵容',
  'season.tradeWindow': '🔄 交易窗口',
  'season.simulateSecond': '▶ 模拟下半赛季',
  'season.averages': '球队场均数据',
  'season.firstHalf': '上半赛季',
  'season.fullSeason': '全赛季',
  'season.afterGames': '场比赛后',
  'season.form': '赛季状态',
  'season.gameStreak': '连胜/连败',
  'season.win': '胜',
  'season.loss': '负',
  'season.awards': '常规赛奖项',
  'season.mvp': '🏆 MVP',
  'season.dpoy': '🛡️ 最佳防守',
  'season.sixthMan': '🔥 最佳第六人',
  'season.allNba': '🌟 最佳阵容一阵',
  'season.missedPlayoffs': '你未能进入季后赛。',
  'season.backHome': '返回首页',
  'season.toPlayoffs': '继续季后赛',

  // ---- Game log ----
  'log.vs': 'vs',
  'log.at': '@',
  'log.injured': '伤病',
  'log.games': '场',

  // ---- Trade ----
  'trade.pointsRemaining': '剩余交易点数',
  'trade.pointsThis': '本赛季可用',
  'trade.rules': '规则：1换1消耗1点 · 2换2消耗2点 · 3换3消耗3点。每赛季共3点。',
  'trade.propose': '提案',
  'trade.shop': '挂牌求购',
  'trade.incoming': '收到报价',
  'trade.yourPlayers': '你的球员（1-3人）',
  'trade.pickSame': '选择同等数量',
  'trade.proposeBtn': '提出交易',
  'trade.shopBtn': '获取报价',
  'trade.acceptBtn': '接受',
  'trade.pickPlayers': '挂牌这些球员（1-3人）',
  'trade.leagueLog': '联盟交易记录',
  'trade.accepted': '交易达成',
  'trade.rejected': '交易被拒绝',
  'trade.salaryCap': '工资帽',
  'trade.cantIncrease': '不能增加薪资',
  'trade.needSame': '请选择同等数量（1-3人）。',
  'trade.notEnough': '交易点数不足',
  'trade.remaining': '剩余',

  // ---- Playoffs ----
  'playoffs.title': '季后赛',
  'playoffs.settingUp': '正在设置对阵…',
  'playoffs.bracket': '季后赛对阵',
  'playoffs.round': '轮次',
  'playoffs.simulateRound': '模拟第',
  'playoffs.roundResult': '轮结果',
  'playoffs.def': '击败',
  'playoffs.youWon': '你赢了',
  'playoffs.youLost': '你输了',
  'playoffs.mvp': '🏅 系列赛MVP',
  'playoffs.seriesRosters': '双方阵容（各10人）',
  'playoffs.playerAverages': '球员场均（系列赛）',
  'playoffs.champion': '🏆 总冠军',
  'playoffs.wonChampionship': '赢得了总冠军！',
  'playoffs.seeResult': '查看结果',
  'playoffs.nextRound': '模拟第',
  'playoffs.eliminated': '你在第',
  'playoffs.eliminatedEnd': '轮被淘汰。季后赛继续进行。',
  'playoffs.home': '主场',

  // ---- Result ----
  'result.champions': '🏆 总冠军！',
  'result.championsSub': '赢得了NBA总决赛。',
  'result.eliminated': '在第',
  'result.eliminatedRound': '轮被淘汰',
  'result.eliminatedSub': '你的征程结束了。重建再战。',
  'result.wonTitle': '赢得了总冠军。',
  'result.dynastyMaterial': '王朝之师。',
  'result.rebuild': '你的征程结束了。重建再战。',
  'result.otherChampOther': '赢得了总冠军',
  'result.championships': '冠军次数',
  'result.awardsWon': '获奖次数',
  'result.season': '赛季',
  'result.starters': '首发',
  'result.bench': '替补',
  'result.topScorers': '得分王',
  'result.teamLeaders': '球队领袖',
  'result.nextSeason': '▶ 下赛季',
  'result.dynastyComplete': '🏆 王朝完成 — 已完成',
  'result.seasons': '个赛季。',
  'result.printSummary': '🖨️ 保存/打印摘要',
  'result.backHome': '返回首页',
  'result.dynastyHistory': '王朝历史',
  'result.champion': '冠军',
  'result.record': '战绩',
  'result.pts': '得分',
  'result.reb': '篮板',
  'result.ast': '助攻',
  'result.stl': '抢断',
  'result.blk': '盖帽',

  // ---- Dynasty History table ----
  'history.season': '赛季',
  'history.record': '战绩',
  'history.champion': '冠军',
  'history.mvp': 'MVP',
  'history.result': '结果',
  'history.championLabel': '🏆 冠军',
  'history.missedPlayoffs': '未进季后赛',
  'history.eliminated': '被淘汰 R',
  'history.playoffs': '季后赛',

  // ---- Offseason Recap ----
  'recap.title': '休赛期回顾',
  'recap.continue': '继续',
  'recap.champion': '🏆 总冠军',
  'recap.mvp': '🌟 常规赛MVP',
  'recap.retired': '本休赛期退役球员',
  'recap.noRetirements': '本休赛期无球员退役。',

  // ---- Summary (printable) ----
  'summary.dynasty': '王朝模式',
  'summary.seasonSummary': '赛季总结',
  'summary.seasons': '个赛季',
  'summary.championships': '次冠军',
  'summary.seasonHistory': '赛季历史',
  'summary.awards': '奖项',
  'summary.roster': '阵容',
  'summary.teamLeaders': '球队领袖',
  'summary.generated': '生成于',

  // ---- Resume labels ----
  'resume.draft': '选秀中',
  'resume.lineup': '设置首发五人',
  'resume.freeagency': '休赛期自由市场',
  'resume.preseason': '准备开始赛季',
  'resume.midseason': '赛季中段',
  'resume.season': '赛季完成',
  'resume.playoffs': '季后赛',
  'resume.finished': '赛季结束 — 查看结果',
  'resume.rookieDraft': '新秀选秀',

  // ---- Matchup ----
  'matchup.desc': '组建两支10人球队,各设5名首发,然后模拟对决。',
  'matchup.mode': '模式',
  'matchup.regular': '常规赛',
  'matchup.playoff': '季后赛（首发/前8人加权）',
  'matchup.times': '次数（最多100）',
  'matchup.simulate': '模拟',

  // ---- Player library ----
  'lib.position': '位置',
  'lib.all': '全部',
  'lib.search': '搜索',
  'lib.searchPlaceholder': '球员名字…',
  'lib.sortHint': '点击列标题排序。',
  'lib.header.name': '名字',
  'lib.header.pos': '位置',
  'lib.header.ovr': '能力值',
  'lib.header.rtg': '评分',
  'lib.header.age': '年龄',

  // ---- Save/Backup ----
  'save.export': '⬇ 导出存档',
  'save.import': '⬆ 导入存档',
  'save.sessionId': '你的Session ID — 保存它以便恢复进度：',
  'save.copy': '复制',
  'save.switch': '切换到另一个Session：',
  'save.switchPlaceholder': '粘贴Session ID',
  'save.switchBtn': '切换',

  // ---- Standings ----
  'standings.title': '排名',
  'standings.east': '东部',
  'standings.west': '西部',

  // ---- Playoff bracket ----
  'bracket.round1': '首轮',
  'bracket.round2': '次轮',
  'bracket.confFinals': '分区决赛',
  'bracket.finals': '总决赛',

  // ---- Misc ----
  'misc.loading': '加载中…',
  'misc.noHistory': '暂无历史记录。',
  'misc.noTrophies': '暂无奖杯。赢得一座总冠军！',
  'misc.noHof': '暂无名人堂成员。',
  'misc.noArchive': '暂无赛季存档。',
  'misc.firstHalfOnly': '仅上半赛季',
  'misc.secondHalfOnly': '仅下半赛季',
  'misc.good': '好',
  'misc.bad': '差',
  'misc.pts': '分',
  'misc.reb': '篮板',
  'misc.ast': '助攻',
  'misc.tripleDouble': '三双',
  'misc.injured': '伤病',
  'misc.games': '场',
  'misc.savesNone': '暂无存档。',
  'misc.sessionCopied': 'Session ID 已复制。',
  'misc.copyFailed': '复制失败 — 请手动选择并复制。',
  'misc.pasteFirst': '请先粘贴Session ID。',
  'misc.freeAgent': '自由球员',
};

const t = (key) => LANG[key] || key;

// Apply translations to all elements with data-i18n attribute
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (LANG[key]) el.textContent = LANG[key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (LANG[key]) el.placeholder = LANG[key];
  });
}
