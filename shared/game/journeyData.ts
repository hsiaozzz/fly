import type { GameData } from "./types";
import GAME_SPEC_SCHEMA from "../../spec/gamespec.schema.json";

/**
 * 数据表 JSON Schema。刻意保持宽松：引擎对未知 effects 字段宽容，
 * 因此新增内容字段（如 cargo）不需要回头改 schema。
 */
export const JOURNEY_DATA_SCHEMA = GAME_SPEC_SCHEMA.properties.data;

/**
 * 《长风万里》默认旅程数据。
 * 所有内容都是数据：新增地貌带 / 节点 / 事件 / 结局无需改动引擎。
 */
export const DEFAULT_JOURNEY_DATA: GameData = {
  start: { coin: 60, fodder: 6, water: 6, stamina: 100, vigor: 100, bond: 20, insight: 0, renown: 0, guilt: 0, day: 1, medicine: 1 },
  regions: [
    { id: "qingwu", name: "青芜草原", speed: 1.0, drain: 1.0, weather: ["clear", "rain"], palette: ["#8fd0ff", "#e6f4d9", "#6aa84f"], hazards: ["fence"] },
    { id: "baihua", name: "白桦林海", speed: 0.85, drain: 1.15, weather: ["fog", "rain"], palette: ["#cbd5e1", "#eaf1e6", "#4f7a3a"], hazards: ["root", "wolf"] },
    { id: "chisha", name: "赤砂瀚海", speed: 0.7, drain: 1.45, weather: ["sandstorm", "heat"], palette: ["#f6d7a3", "#f2c48a", "#d9a441"], hazards: ["quicksand", "dune_maw"] },
    { id: "tiezhen", name: "铁砧峡谷", speed: 0.75, drain: 1.3, weather: ["rockfall", "clear"], palette: ["#9aa5b1", "#d6dde4", "#7d6a58"], hazards: ["rock", "bandit"] },
    { id: "yunling", name: "云岭雪原", speed: 0.65, drain: 1.55, weather: ["blizzard", "clear"], palette: ["#dbeafe", "#f1f5f9", "#dde5ee"], hazards: ["ice", "snow_leopard"] },
    { id: "canglan", name: "沧澜海岸", speed: 0.9, drain: 1.05, weather: ["tide", "rain"], palette: ["#a5f3fc", "#e0f2fe", "#c9b78c"], hazards: ["tide", "slick"] },
    { id: "cangmang", name: "苍茫高台", speed: 0.8, drain: 1.6, weather: ["gale", "clear"], palette: ["#c7b8ff", "#f7dcfe", "#8b7d6b"], hazards: ["cliff", "vulture"] },
  ],
  nodes: [
    { id: "liuwan", region: "qingwu", name: "柳湾村", kind: "village", distance: 120 },
    { id: "qinghe", region: "qingwu", name: "青河渡", kind: "camp", distance: 140 },
    { id: "mumapo", region: "qingwu", name: "牧马坡", kind: "stable", distance: 160 },
    { id: "baihuayi", region: "baihua", name: "白桦驿", kind: "stable", distance: 180 },
    { id: "wuzhao", region: "baihua", name: "雾沼", kind: "ruin", distance: 160 },
    { id: "liehuying", region: "baihua", name: "猎户营", kind: "village", distance: 170 },
    { id: "shajing", region: "chisha", name: "沙井", kind: "camp", distance: 200 },
    { id: "tuolingji", region: "chisha", name: "驼铃集", kind: "village", distance: 210 },
    { id: "duanyuancheng", region: "chisha", name: "断垣城", kind: "ruin", distance: 180 },
    { id: "zhandaoguan", region: "tiezhen", name: "栈道关", kind: "gate", distance: 170 },
    { id: "tiezhenzhen", region: "tiezhen", name: "铁砧镇", kind: "village", distance: 190 },
    { id: "duandaoying", region: "tiezhen", name: "断刀营", kind: "ruin", distance: 160 },
    { id: "xuexianwu", region: "yunling", name: "雪线屋", kind: "stable", distance: 200 },
    { id: "binghu", region: "yunling", name: "冰湖", kind: "camp", distance: 180 },
    { id: "yinxiushishi", region: "yunling", name: "隐修石室", kind: "ruin", distance: 170 },
    { id: "yantiancun", region: "canglan", name: "盐田村", kind: "village", distance: 150 },
    { id: "canglandukou", region: "canglan", name: "沧澜渡口", kind: "gate", distance: 160 },
    { id: "guidengta", region: "canglan", name: "归灯塔", kind: "camp", distance: 180 },
    { id: "fengshitai", region: "cangmang", name: "风蚀台", kind: "ruin", distance: 190 },
    { id: "mushenyuan", region: "cangmang", name: "牧神原", kind: "camp", distance: 200 },
    { id: "guixiangling", region: "cangmang", name: "归乡岭", kind: "gate", distance: 150 },
  ],
  events: [
    {
      id: "ev_start", region: "qingwu", weight: 0, title: "出发", text: "父亲留下的《环洲风物记》缺了二十一页。末页写着：绕一圈，你才知道家在哪儿。", choices: [
        { id: "go", label: "上马，向西。", effects: { bond: 5, insight: 2 }, log: "你在晨雾里出了村口。" },
      ],
    },
    {
      id: "ev_ditch", weight: 10, title: "塌陷的沟渠", text: "雨后土路塌了半幅，绕行要多走半天，硬冲可能伤到马腿。", choices: [
        { id: "jump", label: "策马跃过", effects: { stamina: -8, bond: 2 }, log: "青骢腾空而过，你听见风声。" },
        { id: "detour", label: "绕行", effects: { day: 1, fodder: -1 }, log: "多走了半天，马倒是稳当。" },
      ],
    },
    {
      id: "ev_wolf", region: "baihua", weight: 14, title: "林中有绿光", text: "枯枝后浮着几对眼睛，灰狼在尾随。火把只剩一支。", choices: [
        { id: "torch", label: "点燃火把驱赶", effects: { coin: -5, stamina: -5, bond: 3 }, log: "火光一闪，狼群退回林子。" },
        { id: "gallop", label: "疾驰甩脱", effects: { stamina: -18, bond: -2 }, log: "你伏低身子，风灌满衣领。" },
        { id: "fight", label: "下马硬拼", effects: { vigor: -20, injury: 1, renown: 1, bond: 4 }, log: "你受了点伤，狼群散了。" },
      ],
    },
    {
      id: "ev_sandstorm", region: "chisha", weight: 16, title: "沙墙压境", text: "地平线变黄。沙暴还有一刻钟就到，前方有处背风的岩窝。", choices: [
        { id: "shelter", label: "躲进岩窝", effects: { day: 1, water: -2, stamina: 10 }, log: "你在岩窝里听了一夜风。" },
        { id: "push", label: "顶着风赶路", effects: { stamina: -25, water: -2, insight: 3 }, log: "沙粒打在脸上，你看见了沙暴里的星空。" },
      ],
    },
    {
      id: "ev_bandit", region: "tiezhen", weight: 15, title: "断刀拦路", text: "一个疤脸汉子横刀立马：「留下买路钱。」他的刀鞘上刻着旧军的编号。", choices: [
        { id: "pay", label: "交出银角", effects: { coin: -30, renown: -1 }, log: "他数了数钱，让开了路。" },
        { id: "charge", label: "冲阵反抗", effects: { stamina: -15, injury: 1, insight: 4, renown: 1 }, log: "你撞开刀锋，他望着你笑了笑。" },
        { id: "recruit", label: "邀请同行", requires: "renown>=3", effects: { bond: 5, renown: 2, insight: 6, coin: -10 }, log: "「断刀」把刀插回鞘里，跟了上来。" },
      ],
    },
    {
      id: "ev_caravan", region: "yunling", weight: 15, title: "雪里的商队", text: "三辆货车陷在雪里，人已经冻得说不出话。你的干草只够自己吃两天。", choices: [
        { id: "save", label: "分粮救人", effects: { fodder: -3, water: -2, renown: 2, insight: 5, bond: 4 }, log: "他们把一枚铜铃塞进你手里。" },
        { id: "pass", label: "绕过去", effects: { day: -1, guilt: 3, insight: -5 }, log: "你绕开了。铃声在身后响到听不见。" },
      ],
    },
    {
      id: "ev_hermit", region: "yunling", weight: 12, title: "隐修石室", text: "石室里的老人抬头看你：「你绕这一圈，是为了看见，还是为了被看见？」", choices: [
        { id: "see", label: "为了看见", effects: { insight: 8, bond: 3 }, log: "老人点头，指了指墙上未完成的环洲图。" },
        { id: "seen", label: "为了被看见", effects: { insight: 3, renown: 2, guilt: -2 }, log: "老人笑了，说：那你会走得很远，也会很累。" },
      ],
    },
    {
      id: "ev_ferry", region: "canglan", weight: 13, title: "渡口", text: "渡船夫要十五银角，或者你帮他修好绞盘。", choices: [
        { id: "pay", label: "付船钱", effects: { coin: -15 }, log: "船离岸时，他朝你点了点头。" },
        { id: "fix", label: "修绞盘", effects: { vigor: -12, renown: 1, bond: 2, insight: 3 }, log: "你满手油污，船夫免了船钱。" },
      ],
    },
    {
      id: "ev_wildhorse", region: "cangmang", weight: 12, title: "牧神原的野马群", text: "上百匹野马在风里奔跑，为首的是一匹通体如墨的儿马。", choices: [
        { id: "catch", label: "尝试驯服", effects: { day: 2, stamina: -20, bond: 12, insight: 8 }, log: "第三天清晨，它自己走到了你身边。" },
        { id: "letgo", label: "静静看着", effects: { insight: 6, bond: 5 }, log: "你看了很久，直到它们变成地平线上的黑点。" },
      ],
    },
    {
      id: "ev_merchant", weight: 10, title: "路遇行商", text: "「盐带到雪原能翻四倍价钱，小兄弟，敢不敢赌一把？」", choices: [
        { id: "buy", label: "低价囤盐", effects: { coin: -40, cargo: 10 }, log: "你的马驮上了两袋盐。" },
        { id: "skip", label: "不冒这个险", effects: { insight: 1 }, log: "行商笑笑，赶着车走了。" },
      ],
    },
    {
      id: "ev_injury", weight: 9, title: "蹄子有点瘸", text: "青骢右前蹄不敢用力。老兽医要十二银角。", choices: [
        { id: "heal", label: "请兽医", effects: { coin: -12, injury: -1, bond: 5 }, log: "他捏了捏马腿：「再跑十里就废了。」" },
        { id: "self", label: "自己处理", effects: { medicine: -1, stamina: -10, injury: -1, bond: 2 }, log: "你用完了最后一点药膏。" },
        { id: "ignore", label: "再撑一段", effects: { injury: 1, stamina: -15, bond: -6 }, log: "马在夜里低低地嘶了一声。" },
      ],
    },
    {
      id: "ev_child", weight: 9, title: "送信的女孩", text: "「我叫芸，我师兄在雪原画地图，三个月没消息了。你若见到他，替我带句话。」", choices: [
        { id: "accept", label: "答应她", effects: { insight: 4, renown: 1 }, log: "她把一封信塞进你的鞍袋。" },
        { id: "refuse", label: "路太远了", effects: { guilt: 2, insight: -2 }, log: "她点点头，没再说话。" },
      ],
    },
    {
      id: "ev_ruin", weight: 10, title: "废墟里的石碑", text: "碑文被风蚀得只剩半句：「……行万里者，不问归期。」", choices: [
        { id: "rub", label: "拓印碑文", effects: { vigor: -8, insight: 6 }, log: "你把半句话收进了游记。" },
        { id: "rest", label: "在碑下歇一晚", effects: { day: 1, stamina: 15, vigor: 15, insight: 2 }, log: "你睡得很好。" },
      ],
    },
    {
      id: "ev_rain", weight: 8, title: "一场冷雨", text: "雨点砸下来，前面的路会变成泥塘。", choices: [
        { id: "shelter", label: "搭起油布", effects: { day: 1, stamina: 12, vigor: 10 }, log: "你们挤在油布下听雨。" },
        { id: "ride", label: "冒雨赶路", effects: { stamina: -12, vigor: -12, insight: 3 }, log: "泥水溅了满脸，但路确实短了。" },
      ],
    },
    {
      id: "ev_vulture", region: "cangmang", weight: 11, title: "秃鹫盘旋", text: "三只秃鹫在你头顶越盘越低——它们在等马倒下。", choices: [
        { id: "scare", label: "挥鞭驱赶", effects: { stamina: -6, bond: 4 }, log: "鞭响过后，它们散开了。" },
        { id: "cover", label: "盖住行囊", effects: { vigor: -6 }, log: "你用斗篷盖住鞍袋，继续走。" },
      ],
    },
    {
      id: "ev_lighthouse", region: "canglan", weight: 10, title: "灯塔遗书", text: "守塔人留下的笔记最后一页：「如果有人读到这行字，请把灯点上。」", choices: [
        { id: "light", label: "点上灯", effects: { vigor: -10, insight: 7, renown: 2 }, log: "海面上亮起一点光。" },
        { id: "take", label: "只带走笔记", effects: { insight: 3 }, log: "你合上笔记，灯塔依旧黑着。" },
      ],
    },
  ],
  /**
   * 21 个委托：每个落脚点一件。
   * 结构复用事件的 choices/effects 解释器，差别只在「由节点触发、一生一次」。
   */
  quests: [
    {
      id: "q_seed", node: "liuwan", title: "捎一袋草籽", giver: "村口的老妇",
      text: "「后生，往西去的话，替我把这袋草籽捎到青河渡。我儿子在那儿摆渡，他认得这袋子。」",
      choices: [
        { id: "yes", label: "接下袋子", effects: { day: 1, vigor: -6, coin: 8, bond: 2 }, log: "草籽在鞍袋里沙沙响了一路。" },
        { id: "no", label: "路太赶了", effects: { guilt: 1 }, log: "她笑了笑，把袋子收了回去。" },
      ],
    },
    {
      id: "q_pole", node: "qinghe", title: "找回竹篙", giver: "摆渡少年",
      text: "「昨夜水涨，篙被冲走了。没了篙，这船就是块浮木。」他指着下游的芦苇荡。",
      choices: [
        { id: "search", label: "下芦苇荡去找", effects: { day: 1, vigor: -10, coin: 14, insight: 2 }, log: "篙插在泥里，像谁随手插下的一支旗。" },
        { id: "skip", label: "我赶时间", effects: { guilt: 1 }, log: "他没再说话，蹲在岸边削木头。" },
      ],
    },
    {
      id: "q_eye", node: "mumapo", title: "替他相一匹马", giver: "老马贩",
      text: "「我这眼力不行了。坡上那群马，你替我挑一匹能跑长途的——或者，你自己下场跑一趟给我看。」",
      choices: [
        { id: "race", label: "自己跑一趟给他看", effects: { stamina: -20, coin: 30, renown: 1, bond: 3 }, log: "风从耳边灌进去，老马贩在坡上拍大腿。" },
        { id: "judge", label: "慢慢帮他相马", effects: { vigor: -8, coin: 12, insight: 2 }, log: "你挑了匹肩背宽的，他给了你一半的谢礼。" },
        { id: "skip", label: "我不懂马", effects: { insight: 1 }, log: "「那就去懂。」他说。" },
      ],
    },
    {
      id: "q_letter", node: "baihuayi", title: "一封信，往西", giver: "驿站掌柜",
      text: "「这封信压了两个月了。往西的人少，肯捎信的更少。」信封上没有落款，只画了一枚小小的铃铛。",
      choices: [
        { id: "take", label: "收进鞍袋", effects: { day: 1, coin: 18, renown: 1, insight: 3 }, log: "你摸了摸信，纸很薄，里面的东西却硬。" },
        { id: "ask", label: "先问问是谁的信", effects: { insight: 4, guilt: -1 }, log: "掌柜摇头：「我劝你别问。」你把信收下了。" },
        { id: "refuse", label: "不捎", effects: { guilt: 2 }, log: "信又回到了抽屉里，等着下一个往西的人。" },
      ],
    },
    {
      id: "q_box", node: "wuzhao", title: "沼底的铜匣", giver: "拾荒人",
      text: "「我看见过它，绿的，方方正正，就在沼底。我下不去——我这条腿。」他拍拍瘸了的膝盖。",
      choices: [
        { id: "dive", label: "潜下去摸", effects: { vigor: -16, coin: 26, insight: 4, stamina: -6 }, log: "匣子里是一叠泡烂的通关文牒，和一枚很好的银扣。" },
        { id: "rope", label: "用绳子套", effects: { vigor: -8, coin: 12, insight: 2 }, log: "绳子断了两次，第三次才把匣子拖上来。" },
        { id: "skip", label: "沼底不干净", effects: { insight: -1 }, log: "你看了眼黑水，摇了摇头。" },
      ],
    },
    {
      id: "q_wolfden", node: "liehuying", title: "端掉狼窝", giver: "猎户头领",
      text: "「开春那窝狼咬死了我们两条狗。今冬它们就该饿得下山了。」他把火把递过来。",
      choices: [
        { id: "go", label: "跟他进林子", effects: { vigor: -18, injury: 1, coin: 20, renown: 2, insight: 2 }, log: "狼窝空了，只剩一地啃净的骨头。它们已经下山了。" },
        { id: "advise", label: "劝他们迁营", effects: { insight: 3, renown: 1, day: 1 }, log: "他们听了一半，把老人孩子先送下了山。" },
        { id: "skip", label: "这不是我的事", effects: { guilt: 2 }, log: "火把在他手里烧到天亮。" },
      ],
    },
    {
      id: "q_well", node: "shajing", title: "井底下", giver: "守井老人",
      text: "「井快见底了。底下还有一汪，得下去掏。」绳子磨得起了毛，井壁上的砖松动。",
      choices: [
        { id: "down", label: "缒下井去", effects: { vigor: -14, water: 3, insight: 3, coin: 10 }, log: "你在井底摸到了凉水，也摸到了一只旧铜壶。" },
        { id: "bucket", label: "用长绳吊桶", effects: { vigor: -6, water: 1, coin: 6 }, log: "桶上来的水浑，但终究是水。" },
        { id: "skip", label: "我的水也不多了", effects: { guilt: 1 }, log: "老人自己往下缒，绳子吱呀作响。" },
      ],
    },
    {
      id: "q_saltcart", node: "tuolingji", title: "护送盐车", giver: "驼铃集的盐商", requires: "renown>=2",
      text: "「三辆车，十二个人，走到铁砧镇就行。路上不太平，但你的名头我听说过。」",
      choices: [
        { id: "escort", label: "接下护送", effects: { day: 2, stamina: -15, coin: 40, renown: 2, insight: 3 }, log: "盐车一辆不少地进了镇口。盐商多给了你一袋好料。" },
        { id: "haggle", label: "先谈价钱", effects: { coin: 48, renown: -1, day: 2, insight: 1 }, log: "你多要了八银角，他在账本上记了一笔。" },
        { id: "skip", label: "不趟这浑水", effects: { insight: 1 }, log: "车队在你之后出发，铃铛响了很久。" },
      ],
    },
    {
      id: "q_brick", node: "duanyuancheng", title: "城砖上的名字", giver: "拓碑的疯老头",
      text: "「这城不是塌的，是拆的。砖上都刻着名字——窑工的名字。我要拓下来，你帮我按住纸。」",
      choices: [
        { id: "help", label: "帮他拓一整天", effects: { vigor: -12, insight: 8, coin: 6 }, log: "宣纸上浮出密密麻麻的名字，像一片沉默的兵。" },
        { id: "half", label: "拓半日就走", effects: { vigor: -6, insight: 4, coin: 4 }, log: "他拓到第三十七块时，你的手已经酸了。" },
        { id: "skip", label: "名字救不了人", effects: { guilt: 1, insight: 1 }, log: "他一个人按着纸，风把纸吹跑了。" },
      ],
    },
    {
      id: "q_baggage", node: "zhandaoguan", title: "关口的行李", giver: "守关卒",
      text: "「有批行李压了三天，主人没来领。往西的要是顺路，捎到铁砧镇，我私人给你点辛苦费。」",
      choices: [
        { id: "carry", label: "捎上行李", effects: { day: 1, stamina: -10, coin: 22, renown: 1 }, log: "行李不重，但捆得极紧，像是不想让人打开。" },
        { id: "peek", label: "先看看装了什么", effects: { insight: 5, coin: 12, guilt: 1 }, log: "是半箱子旧军衣。你原样捆了回去。" },
        { id: "skip", label: "马已经很累了", effects: { insight: 1 }, log: "行李又靠回了墙角。" },
      ],
    },
    {
      id: "q_shoe", node: "tiezhenzhen", title: "铁匠的马掌", giver: "独臂铁匠",
      text: "「订掌的人没来取。你要是往西，替我带一副过去——顺手，也给你自己打一副？算你便宜。」",
      choices: [
        { id: "deliver", label: "只管送", effects: { day: 1, coin: 16, insight: 2 }, log: "你把掌交到了收货人手里，他连声道谢。" },
        { id: "buy", label: "顺手给自己也打一副", effects: { coin: -2, injury: -1, bond: 3, day: 1 }, log: "新掌钉上去，青骢踩在碎石上稳当多了。" },
        { id: "skip", label: "没空", effects: { insight: 1 }, log: "铁匠把掌扔回筐里，叮当一声。" },
      ],
    },
    {
      id: "q_dogtag", node: "duandaoying", title: "断刀的旧军牌", giver: "疤脸女子", requires: "renown>=3",
      text: "「他不肯说，但我知道他把军牌埋在这营里的某块石头下。你替我找出来，我想知道他到底是谁。」",
      choices: [
        { id: "dig", label: "替她翻遍营地", effects: { day: 1, vigor: -14, insight: 10, renown: 2, coin: 15 }, log: "军牌上是一个被划掉的编号。她看完，把它埋了回去。" },
        { id: "ask", label: "直接去问他", effects: { insight: 12, renown: 1, stamina: -6 }, log: "断刀沉默了很久，说：「那不是我的名字。」" },
        { id: "skip", label: "别人的旧账", effects: { guilt: 1, insight: 2 }, log: "她没拦你，只是继续在石头缝里抠。" },
      ],
    },
    {
      id: "q_birth", node: "xuexianwu", title: "雪线屋的孩子", giver: "稳婆", requires: "medicine>=1",
      text: "「孩子要出来了，可她血崩。我这双手不行了——你有药吗？有药就有命。」",
      choices: [
        { id: "give", label: "把药膏给她", effects: { medicine: -1, coin: 24, renown: 2, insight: 4, bond: 3 }, log: "天亮时屋里响起一声哭。稳婆把一只旧银镯塞给你。" },
        { id: "stay", label: "留下守一夜", effects: { day: 1, vigor: -18, renown: 3, insight: 5 }, log: "你守在门外，听着里面的声音一点点弱下去，又一点点强起来。" },
        { id: "skip", label: "我只有这一份药", effects: { guilt: 3, insight: -3 }, log: "你上马时，屋里的灯还亮着。" },
      ],
    },
    {
      id: "q_net", node: "binghu", title: "冰下的渔网", giver: "冰湖渔人",
      text: "「网冻在冰里了。凿开就能拿出来，可这冰今年薄。」他用脚试探地跺了跺。",
      choices: [
        { id: "chop", label: "凿冰取网", effects: { vigor: -14, water: 2, coin: 18, insight: 3 }, log: "冰裂开一道缝，网拉出来时还挂着几条活鱼。" },
        { id: "wait", label: "等开春再说", effects: { day: 1, insight: 2, coin: 6 }, log: "你陪他等了一天，湖面纹丝不动。" },
        { id: "skip", label: "冰太薄", effects: { insight: 1 }, log: "他一个人凿，凿到天黑。" },
      ],
    },
    {
      id: "q_mapwall", node: "yinxiushishi", title: "墙上的环洲图", giver: "隐修者", requires: "insight>=60",
      text: "「我画了四十年，还差西南一角。你走过，你来讲，我来画。」石壁上密密麻麻，全是极小的字。",
      choices: [
        { id: "dictate", label: "把走过的都讲给他", effects: { day: 1, vigor: -16, insight: 14, renown: 1 }, log: "他一边听一边画，手抖得厉害，线条却很稳。" },
        { id: "copy", label: "抄下他画的带走", effects: { vigor: -10, insight: 9, coin: 10 }, log: "你抄到手腕发酸，抄下的比他画的多一处海。" },
        { id: "skip", label: "图是死的", effects: { insight: -2 }, log: "他没抬头，笔尖在石壁上顿了很久。" },
      ],
    },
    {
      id: "q_saltwage", node: "yantiancun", title: "盐田的工钱", giver: "盐工头",
      text: "「东家跑了，工钱没结。你要是往沧澜渡口去，把这摞欠条带给渡口的账房——他自己也欠着我们的。」",
      choices: [
        { id: "carry", label: "带走欠条", effects: { day: 1, stamina: -12, coin: 20, insight: 2, renown: 1 }, log: "欠条有三十七张，每一张都按着手印。" },
        { id: "haggle", label: "替他们去讨", requires: "renown>=4", effects: { coin: 34, renown: 1, day: 1, insight: 3 }, log: "账房看了你的脸，把钱数了三遍才递出来。" },
        { id: "skip", label: "欠条换不了草料", effects: { guilt: 2 }, log: "工头把欠条收进怀里，说：那就再等等。" },
      ],
    },
    {
      id: "q_tide", node: "canglandukou", title: "等潮的人", giver: "渡船夫",
      text: "「今晚有大潮。货主说要来，没来。我一个人不敢在潮里解缆。你陪我等一夜？」",
      choices: [
        { id: "wait", label: "陪他等", effects: { day: 1, coin: 20, renown: 1, insight: 3, vigor: -8 }, log: "潮水在半夜来了又走，货主始终没出现。" },
        { id: "cast", label: "帮他解缆抢潮", effects: { stamina: -14, coin: 28, renown: 2, insight: 2 }, log: "船在浪里横过来，你们两个人都湿透了，但货保住了。" },
        { id: "skip", label: "我明天还得赶路", effects: { guilt: 1 }, log: "他一个人在码头上坐着，灯笼亮到天明。" },
      ],
    },
    {
      id: "q_lamp", node: "guidengta", title: "把灯点上", giver: "守塔人的女儿",
      text: "「父亲死后灯就灭了。油还有半缸，可我爬不上去那梯子——它朽了。」",
      choices: [
        { id: "climb", label: "爬上去点灯", effects: { vigor: -14, insight: 12, renown: 2, coin: 8 }, log: "火苗窜起来的一瞬，海面上有船改变了航向。" },
        { id: "oil", label: "留下油就走", effects: { coin: -8, insight: 4, renown: 1 }, log: "她接过油壶，说：等下一个人来点吧。" },
        { id: "skip", label: "梯子太危险", effects: { guilt: 2, insight: -1 }, log: "灯塔黑着，你走了很久还能看见它的轮廓。" },
      ],
    },
    {
      id: "q_bell", node: "fengshitai", title: "风里的铜铃", giver: "老牧人",
      text: "「风蚀台上挂着一只铃，我年轻时挂的。绳子早断了，铃还在石头缝里。我想要回来。」",
      choices: [
        { id: "climb", label: "爬上去够铃", effects: { vigor: -16, insight: 9, coin: 12, bond: 2 }, log: "铃身上刻着两个已经磨平的字。老牧人没说是什么。" },
        { id: "listen", label: "只在下面听风", effects: { insight: 5, bond: 3 }, log: "风穿过石缝，真的像铃在响。" },
        { id: "skip", label: "风太大了", effects: { insight: 1 }, log: "他抬头看了很久，转身走了。" },
      ],
    },
    {
      id: "q_black", node: "mushenyuan", title: "套住那匹黑的", giver: "套马手", requires: "bond>=50",
      text: "「那匹墨色的儿马，我套了三年。你的马跟你好，它能带我靠近。敢不敢？」",
      choices: [
        { id: "try", label: "下场去套", effects: { day: 1, stamina: -25, bond: 10, insight: 8, coin: 30 }, log: "第三次它才让你靠近。你伸手时，它自己把头低了下来。" },
        { id: "watch", label: "只在旁边看着", effects: { insight: 4, bond: 5 }, log: "它站在风里看你，看了很久，然后转身跑去。" },
      ],
    },
    {
      id: "q_homemsg", node: "guixiangling", title: "带回一句话", giver: "守岭人",
      text: "「翻过这道岭就是柳湾了。你要是回去，替我告诉槐树底下那个修鞋的：我今年又不回去了。」",
      choices: [
        { id: "take", label: "记下这句话", effects: { day: 1, coin: 26, renown: 2, insight: 5 }, log: "你把这句话写在游记最后一页的空白处。" },
        { id: "ask", label: "问他是谁", effects: { insight: 8, renown: 1 }, log: "「我是她哥。」他说完，就不再说话了。" },
      ],
    },
  ],
  /**
   * 7 桩隐藏奇遇：一桩对应一处风貌带。
   * 触发靠「状态门槛」而非随机——玩家的行为（羁绊、见闻、清白、速写数）决定能不能遇上。
   */
  secrets: [
    {
      id: "sc_grave", region: "qingwu", title: "老槐树的第三道刻痕", requires: "bond>=28",
      hint: "有人说柳湾的老槐树上刻着三道痕，第三道下面埋着东西。",
      text: "老槐树的第三道刻痕离地三尺，你小时候够不着。现在你够得着了——刻痕下是一小段缰绳，和一封没拆的信。",
      choices: [
        { id: "open", label: "拆开那封信", effects: { insight: 14, bond: 6, medicine: 1 }, log: "父亲的字：「若你读到这行字，说明你没把马当牲口。」" },
        { id: "bury", label: "原样埋回去", effects: { insight: 6, bond: 8 }, log: "你没拆。有些话是要等自己走到那一步才配读的。" },
      ],
    },
    {
      id: "sc_deer", region: "baihua", title: "林中的白鹿", requires: "guilt<=0",
      hint: "猎户说，手上没沾过亏心事的人，才看得见林子里那头白鹿。",
      text: "雾散了一瞬。林子深处站着一头白鹿，角上挂着霜。它没有跑，只是看着你。",
      choices: [
        { id: "follow", label: "跟它走", effects: { insight: 18, bond: 5, vigor: -8 }, log: "它把你带出了一片你本会迷路三天的林子。" },
        { id: "stay", label: "站着不动", effects: { insight: 10, bond: 8 }, log: "你们对视了很久。它转身时，霜从角上落下来。" },
      ],
    },
    {
      id: "sc_road", region: "chisha", title: "沙下的旧驿道", requires: "insight>=40",
      hint: "沙井的老人说，瀚海底下埋着一条一百年前的驿道，还有半块界碑。",
      text: "风把沙吹开一道口子。青石板铺得整整齐齐，通向一个谁也不再去的方向。半块界碑露出地面。",
      choices: [
        { id: "dig", label: "把界碑掘出来", effects: { vigor: -14, insight: 20, renown: 1 }, log: "碑上的路名，在你父亲那本游记的缺页里出现过。" },
        { id: "mark", label: "在游记上标下位置", effects: { insight: 11, coin: 14 }, log: "你画了图，把这条驿道留给了下一个走这边的人。" },
      ],
    },
    {
      id: "sc_comrade", region: "tiezhen", title: "旧部的刀", requires: "renown>=4",
      hint: "峡谷里还藏着几个不肯卸甲的人。你的名字已经传到他们耳朵里了。",
      text: "三个衣衫褴褛的人从岩后转出来，为首那个看了你很久：「你就是那个往西走的？」他们腰间的刀鞘上，都刻着同一种编号。",
      choices: [
        { id: "talk", label: "坐下来喝一碗", effects: { coin: -10, renown: 3, insight: 16, bond: 3 }, log: "他们讲的那场仗，史书上一个字也没有。" },
        { id: "leave", label: "只点点头就走", effects: { insight: 6, guilt: 1 }, log: "他们没拦你。身后传来刀鞘磕在石头上的声音。" },
      ],
    },
    {
      id: "sc_yansheng", region: "yunling", title: "雪里的制图师", requires: "insight>=85",
      hint: "那个叫芸的女孩托你找的人，据说在雪线以上画完了最后一张图。",
      text: "石屋的门推不开。你从窗缝里看见一个人伏在图上，手已经冻得握不住笔。他是砚生，他还活着。",
      choices: [
        { id: "down", label: "背他下山", effects: { day: 2, insight: 26, renown: 3, coin: 30, vigor: -14 }, log: "他一路都在说：图还没画完，图还没画完。" },
        { id: "stay", label: "留下来陪他画完", effects: { day: 3, insight: 34, renown: 1, vigor: -20, stamina: -10 }, log: "最后一笔落下去时，窗外雪停了。他睡了三天。" },
      ],
    },
    {
      id: "sc_chart", region: "canglan", title: "灯塔密室的海图", requires: "sketch>=4",
      hint: "归灯塔的墙里有个暗格。据说要画够四处风物的人，才看得懂暗格上的记号。",
      text: "你数着自己速写过的四处地方，按那四个位置拨动了塔基的铜环。墙开了一道缝，里面是一卷海图——画的是环洲之外的大海。",
      choices: [
        { id: "take", label: "带走海图", effects: { insight: 24, renown: 2, flag_seachart: 1 }, log: "海图边缘写着一行小字：外环诸岛，秋后可往。" },
        { id: "leave", label: "留在原处", effects: { insight: 10, bond: 4 }, log: "你关上暗格。有些路要等下一次才走。" },
      ],
    },
    {
      id: "sc_king", region: "cangmang", title: "牧神原的野王", requires: "bond>=78",
      hint: "牧人传说，那匹通体如墨的儿马只认一种人——马愿意把命交给的人。",
      text: "它从风里走出来，一直走到你的马身边。两匹马鼻子碰了碰。它没有缰绳，也没有鞍，却向你低下了头。",
      choices: [
        { id: "ride", label: "翻上它的背", effects: { stamina: -20, bond: 22, insight: 26, flag_wildking: 1 }, log: "它没有跑。风从两个方向一起灌进你的衣领。" },
        { id: "free", label: "放它走", effects: { insight: 16, bond: 12 }, log: "它跑了两步，回头看你一眼，然后消失在草浪里。" },
      ],
    },
  ],
  endings: [
    { id: "lost", name: "迷失", condition: "insight<80 || dead", text: "你回到了出发的地方，却认不出自己的村子。游记是空的，风把最后一页吹走了。" },
    { id: "homecoming", name: "归乡", condition: "true", text: "柳湾村的老槐树还在。你把马拴在树下，开始给孩子们讲那些风、沙和雪。" },
    { id: "legacy", name: "传承", condition: "insight>=240 && renown>=8", text: "你把补全的《环洲风物记》交给了一个眼睛很亮的孩子。书比人走得远。" },
    { id: "watch", name: "守望", condition: "renown>=12 && guilt<=0 && bond>=70", text: "你在雪线上建了一座驿站。断刀在门口劈柴，铃铛挂在檐下，为每一个赶路的人响。" },
    { id: "beyond", name: "远航", condition: "insight>=300 && bond>=95", text: "环洲走完了，可地图上还有海。你解下鞍鞯，牵着马上了船。" },
  ],
};
