const AGE_TARGET = /\btoddlers?\b|\b(?:one|two|1|2)[ -]year[ -]olds?\b|\b(?:1[2-9]|2[0-4])[ -]months?\b|1[—–-]2\s*岁|1[2-9]\s*个月|2[0-4]\s*个月/i;
const OTHER_AGE = /\bnewborn\b|\btummy[ -]time\b|\bswaddl|\b(?:sit up|sit on their own|sitting up|roll over|rolling over)\b|\b(?:[0-9]|10|11)[ -]months?\b|\b(?:[3-9]|three|four|five)[ -]year[ -]olds?\b|新生儿|趴玩|襁褓|学坐|翻身/i;
const SALES = /\b(?:discount|coupon|giveaway|black friday)\b|优惠码|折扣|抽奖/i;
const TOPIC_RULES = {
  language: /\b(?:speech|talk|talking|language|communication|vocabulary|bilingual|words?)\b|语言|说话|双语|词汇/i,
  movement: /\b(?:gross motor|walking|walk|climbing|climb|balance|obstacle|movement|motor skills)\b|大运动|走路|攀爬|平衡|障碍/i,
  fine_motor: /\b(?:fine motor|pincer|grasp|threading|tongs|posting|puzzles?)\b|精细动作|抓握|穿线|夹子|投入|拼图/i,
  sensory: /\b(?:sensory|play.?dough|texture|scooping|pouring)\b|感官盆|触觉|黏土|舀|倾倒/i,
  art: /\b(?:art|painting|paint|drawing|scribbling|color mixing|colour mixing)\b|美育|艺术|涂鸦|绘画/i,
  reading: /\b(?:books?|reading|read|story.?time|picture books?)\b|绘本|阅读|读书|故事/i,
  everyday: /\b(?:play|playing|games?|activities|activity)\b|亲子|游戏|活动/i,
  theory: /\b(?:development|serve.?and.?return|child.?led|montessori|attachment|early learning)\b|早教|回应式|蒙台梭利|依恋|教育理念/i,
};

export function screenContent(item) {
  const title = item.title;
  const summary = item.description.split('\n')[0].slice(0, 250);
  const text = `${title} ${summary}`;
  if (SALES.test(title) || (OTHER_AGE.test(title) && !AGE_TARGET.test(title))) return null;
  const titleTopics = Object.entries(TOPIC_RULES).filter(([, rule]) => rule.test(title)).map(([topic]) => topic);
  const topics = titleTopics.length ? titleTopics : Object.entries(TOPIC_RULES).filter(([, rule]) => rule.test(text)).map(([topic]) => topic);
  if (!topics.length) return null;
  return { ...item, topics };
}
