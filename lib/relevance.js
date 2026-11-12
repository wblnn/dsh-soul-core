/**
 * 相关性 / 门控：决定"要不要跑检索"，不决定"要不要给"。
 *
 * 这一层存在的原因是一个镜像错误：
 *   删掉"未命中就补简报"之后，如果检索仍然每轮无条件跑、命中即注入，
 *   就变成"命中 ≠ 相关"——`吃了吗` 命中三个月前一条吃饭记录，score 还很高。
 *
 * 两条判断都是廉价的、可解释的：
 *   ① 寒暄不看记忆（在吗/吃了吗/哈哈/早/晚安/嗯/好/单问号）
 *   ② 命中行必须与当前输入有 ≥2 个实词双字重叠，否则丢掉
 */

/** 纯寒暄 / 应答：不触发检索。 */
const PHATIC =
  /^(在吗|在不在|在么|吃了吗|吃了没|睡了吗|早|早安|早上好|晚安|午安|好|嗯|嗯嗯|哦|噢|行|可以|收到|谢谢|谢了|辛苦了|哈+|嘿+|呵+|草|牛|厉害|\?+|？+|\.{2,}|…+|ok|okay|hi|hello|hey)$/i;

/** 尾部语气词：`晚安喵` `在吗呀` 也算寒暄。 */
const TAIL_PARTICLES = /(喵|啊|呀|呢|吧|啦|哦|嘛|哟|噢|诶|哇|哈)+$/;

/** 虚词：参与重叠判定会污染（"的""了""这""那"）。 */
const STOPWORDS = new Set([
  "什么","怎么","这个","那个","就是","还是","可以","一下","我们","你们","他们","自己","现在","刚才",
  "然后","但是","因为","所以","如果","已经","没有","这样","那样","知道","觉得","时候","东西","事情",
  "一个","不是","真的","有点","可能","应该","需要","问题","地方","一点","这么","那么","多少","为什么",
]);

export function isPhatic(text) {
  const t = String(text ?? "").trim();
  if (!t) return true;
  if (PHATIC.test(t)) return true;
  // 去掉尾部语气词再试一次（"晚安喵" / "在吗呀"）
  const stripped = t.replace(TAIL_PARTICLES, "").trim();
  if (stripped && stripped !== t && PHATIC.test(stripped)) return true;
  // 去掉标点后仍然极短：纯应答
  const bare = t.replace(/[\s，。！？、…~～!?.,]/g, "");
  if (bare.length <= 2) return true;
  return false;
}

/** 中文双字 + 英文词（与检索同一套切分，便于比较）。 */
export function terms(text) {
  const out = new Set();
  for (const m of String(text ?? "").toLowerCase().matchAll(/[a-z0-9_]+|[\u4e00-\u9fff]+/g)) {
    const s = m[0];
    if (/[\u4e00-\u9fff]/.test(s)) {
      if (s.length <= 2) if (!STOPWORDS.has(s)) out.add(s);
      if (s.length > 2) {
        for (let i = 0; i < s.length - 1; i++) {
          const bi = s.slice(i, i + 2);
          if (!STOPWORDS.has(bi)) out.add(bi);
        }
      }
    } else if (s.length > 1) {
      out.add(s);
    }
  }
  return out;
}

/**
 * 这条命中跟当前输入到底有没有关系。
 * @returns {{ok:boolean, overlap:number, shared:string[]}}
 */
export function isRelevant(input, hitText, minOverlap = 2) {
  const a = terms(input);
  const b = terms(hitText);
  if (a.size === 0 || b.size === 0) return { ok: false, overlap: 0, shared: [] };
  const shared = [];
  for (const t of a) if (b.has(t)) shared.push(t);
  return { ok: shared.length >= minOverlap, overlap: shared.length, shared: shared.slice(0, 6) };
}
