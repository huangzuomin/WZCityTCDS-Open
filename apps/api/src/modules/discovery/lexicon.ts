/**
 * 实体发现与对齐的词典 / 规则 / 工具层。
 * 这里全是确定性逻辑（不调用 LLM），是「规则打头阵」的那一层：
 * 能用规则拦下的，绝不多花一次 LLM 调用。
 */

// ---------------------------------------------------------------- 类型体系
/**
 * 类型参考词典（v2 降级为参考）：全局分类树才是 type 的权威来源，
 * 发现/审核/关系阶段由 discovery 动态注入「该库关联分类清单」。
 * 这里保留 17 种经典 code，仅作为关联分类之外的兜底参考与启发式工具。
 */
export const TYPES = [
  'geo.region', 'geo.nature', 'geo.road', 'geo.landmark',
  'org.company', 'org.gov', 'org.school', 'org.media',
  'person',
  'culture.custom', 'culture.art', 'culture.dialect', 'culture.food', 'culture.concept', 'culture.school',
  'product', 'event',
] as const;

export type EntityType = (typeof TYPES)[number];

export const TYPE_DESC = `geo.region(温州政区:市/区县/乡镇街道/村), geo.nature(山/江/岛等自然地理), geo.road(道路街巷), geo.landmark(地标建筑景点), org.company(企业/品牌/商铺/酒店), org.gov(政府机构), org.school(学校院所), org.media(媒体), person(人物), culture.custom(民俗节庆活动), culture.art(戏曲手工艺等), culture.dialect(方言), culture.food(饮食), culture.concept(温州模式/温商等抽象概念), culture.school(学派思想), product(产品/特产), event(事件)`;

// ---------------------------------------------------------------- 地域锚
export const REGIONS = ['温州', '鹿城', '龙湾', '瓯海', '洞头', '乐清', '瑞安', '龙港', '永嘉', '平阳', '苍南', '文成', '泰顺'];

/** 文章级温州信号：用于从 5 万篇里筛出值得送 LLM 的语料（省掉大量无关文章） */
export const WENZHOU_SIGNALS = [
  '温州', '瓯', '乐清', '瑞安', '鹿城', '龙湾', '瓯海', '洞头', '永嘉', '平阳', '苍南', '文成', '泰顺', '龙港',
  '雁荡山', '江心屿', '五马街', '温商', '正泰', '森马', '瓯菜', '瓯越', '南戏', '拦街福', '瓯绣', '瓯塑', '楠溪江', '塘河', '朔门',
];

/**
 * 温州元素种子词典（人工维护的白名单）。
 * 命中即直通入库——这是「纠错沉淀」的核心资产：每次人工捞回的实体都该进这里，
 * 下次同类问题零成本命中。
 */
export const GAZETTEER: string[] = [
  // 政区
  '温州', '鹿城', '龙湾', '瓯海', '洞头', '乐清', '瑞安', '龙港', '永嘉', '平阳', '苍南', '文成', '泰顺', '瓯北', '柳市', '虹桥', '塘下', '北白象',
  // 地标/自然
  '五马街', '江心屿', '雁荡山', '楠溪江', '瓯江', '飞云江', '南塘街', '松台山', '华盖山', '景山', '三垟湿地', '朔门古港', '公园路', '解放街', '纱帽河', '府前街', '人民路',
  // 企业/品牌
  '正泰', '德力西', '人民电器', '森马', '奥康', '红蜻蜓', '康奈', '报喜鸟', '庄吉', '美特斯邦威', '青山控股', '华峰', '人本', '温州日报', '温州晚报', '温州都市报', '温州新闻网',
  // 文化
  '瓯越', '东瓯', '瓯菜', '瓯绣', '瓯塑', '瓯剧', '瓯窑', '瓯柑', '温州话', '南戏', '永嘉学派', '事功学派', '拦街福', '黄杨木雕', '细纹刻纸', '米塑', '发绣', '蓝夹缬', '温州鼓词', '龙舟', '台阁', '温商', '温州模式', '温州商人', '皮鞋', '低压电器', '打火机', '眼镜', '剃刀', '汽配', '泵阀', '教玩具', '合成革',
  // 美食
  '鱼丸', '鱼饼', '馄饨', '灯盏糕', '麦饼', '松糕', '锅贴', '胶冻', '酱油肉', '江蟹生', '鸭舌', '血蛤', '泥蒜', '蝤蛑', '杨梅', '白象香糕', '县前头汤圆',
];

// ---------------------------------------------------------------- 确定性拒收规则
/** 报道署名：记者/通讯员/摄影署名不是知识库实体 */
export const SIGNOFF_RE =
  /(记者\s*[\u4e00-\u9fa5]{2,4}\s*[\/／]?\s*(文|摄))|(通讯员\s*[\u4e00-\u9fa5]{2,3})|(摄影\s*[\u4e00-\u9fa5]{2,4})|([\/／]\s*文\b)|([\/／]\s*摄\b)|(本报记者|见习记者|实习记者|特约记者)/;

/** 全国泛在事物：除非文中明确限定温州段，否则不收 */
export const GENERIC_BLACKLIST = new Set(['104国道', 'g15', 'g15高速', '国道', '省道', '高速公路', '高速', '农家乐', '农家小院', '动车', '高铁']);

/** 通用后缀 bigram：召回打分时排除，防止「正泰集团」≈「奥康集团」的假召回 */
export const STOP_BIGRAMS = new Set(['集团', '公司', '街道', '办事', '酒店', '饭店', '学校', '学院', '大学', '中学', '小学', '报社', '电视', '大桥', '国道', '高速', '有限', '股份', '医院', '银行', '实业', '工厂']);

// ---------------------------------------------------------------- 阈值
export const SEM_THRESHOLD = 0.5;   // 语义召回入围线（实测不相关实体 ≤0.47）
export const MERGE_THRESHOLD = 0.85; // LLM 判同采纳线
export const MARGIN_MIN = 0.03;      // 候选分差过小 → 模型自己也分不清 → 转人工
export const TOP1_MIN = 0.5;         // 有字面信号(lit>=0.3)时的绝对分数门槛（top1 低于此值直接判"都不是"）
export const SEM_ONLY_MIN = 0.75;    // 纯语义候选的采信门槛：字面分低时语义必须足够高才值得进 LLM/人工
export const DIFF_CONFIDENCE = 0.8;  // LLM 判异采纳线

// ---------------------------------------------------------------- 文本工具
export const norm = (s: unknown): string =>
  String(s ?? '')
    .replace(/[\u201c\u201d\u2018\u2019\u300c\u300d"']/g, '')
    .replace(/[\u300a\u300b\u3010\u3011\u3008\u3009«»]/g, '') // 书名号《》【】〈〉 去标点，避免同一书/名单两种写法
    .replace(/[，、；：？！。,\s（）()]/g, '')
    .trim();

export function bigrams(s: string): Set<string> {
  const t = norm(s);
  const r = new Set<string>();
  if (t.length < 2) {
    if (t) r.add(t);
    return r;
  }
  for (let i = 0; i < t.length - 1; i += 1) {
    const g = t.slice(i, i + 2);
    if (!STOP_BIGRAMS.has(g)) r.add(g);
  }
  return r;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n / (a.size + b.size - n || 1);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) s += a[i] * b[i];
  return s;
}

/** 从证据句/正文里提取地域锚（用于分块 blocking） */
export function geoAnchor(evidence: string | null | undefined, body?: string | null): string | null {
  for (const r of REGIONS) if ((evidence || '').includes(r)) return r;
  if (body) {
    const inBody = REGIONS.filter((r) => body.includes(r));
    if (inBody.length === 1) return inBody[0];
  }
  return null;
}

/** 种子词典命中（返回命中的词） */
export function gazetteerHit(name: string): string | null {
  const n = norm(name);
  for (const w of GAZETTEER) if (n.includes(w)) return w;
  return null;
}

/** 确定性拒收：命中返回理由，否则 null */
export function ruleReject(e: { name: string; type: string; evidence?: string | null }): string | null {
  if (e.type === 'person' && SIGNOFF_RE.test(e.evidence || '')) return 'non_notable[署名规则]';
  if (GENERIC_BLACKLIST.has(norm(e.name).toLowerCase())) return 'not_local[黑名单规则]';
  return null;
}

/** 从 LLM 回复中抠出 JSON（容忍 markdown 代码块、前后废话、括号不配平） */
export function extractJson<T = unknown>(text: string): T {
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try {
    return JSON.parse(t) as T;
  } catch {
    /* 落到兜底 */
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1)) as T;
    } catch {
      /* 再落到配平 */
    }
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i += 1) {
    const ch = t[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1)) as T;
    }
  }
  throw new Error('JSON括号不配平');
}
