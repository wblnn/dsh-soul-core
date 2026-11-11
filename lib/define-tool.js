/**
 * 工具定义的最小本地实现。
 *
 * 为什么需要它：`@deepseek-ai/dsh-tools` 在插件被 junction 进 profile 时**解析不到**
 * （profile 里 `@deepseek-ai/*` 是指向旧安装路径的失效 junction，实测
 * `ERR_MODULE_NOT_FOUND`）。而 `ctx.tools.register()` 本身只强制校验
 * `output = { schema, render }` 与 `name !== "run_code"`，并不要求 definition
 * 一定出自 `defineTool()`——所以这里自带一份等价的最小实现，作为兜底。
 *
 * 优先仍走官方 `defineTool`（参数校验、presentation 等更完整），只有在 import
 * 失败时才用本地实现。
 */

const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/** 把 `{ name: { type, required, description, enum } }` 转成 JSON Schema。 */
export function parameterSpecToJsonSchema(spec) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec || {})) {
    const entry = value || {};
    const type = TYPES.has(entry.type) ? entry.type : "string";
    const prop = { type };
    if (entry.description) prop.description = entry.description;
    if (Array.isArray(entry.enum) && entry.enum.length > 0) prop.enum = entry.enum;
    properties[key] = prop;
    if (entry.required === true) required.push(key);
  }
  const schema = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * 与官方 `defineTool` 输出形状对齐的最小版本：足够 `ctx.tools.register()` 使用。
 * 不做参数校验（官方版会包装 execute 做校验）；本插件的工具参数少且都有默认分支。
 */
export function localDefineTool(options) {
  if (!options || typeof options !== "object") throw new TypeError("defineTool(options) 需要一个对象");
  if (typeof options.name !== "string" || !options.name) throw new TypeError("defineTool: name 必填");
  if (typeof options.execute !== "function") throw new TypeError(`defineTool(${options.name}): execute 必填`);
  if (!options.output || typeof options.output.render !== "function") {
    throw new TypeError(`defineTool(${options.name}): output.render 必填`);
  }
  return {
    name: options.name,
    description: options.description ?? "",
    parameters: parameterSpecToJsonSchema(options.parameters),
    output: options.output,
    execute: options.execute,
    ...(options.presentCall ? { presentCall: options.presentCall } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
}

export default { localDefineTool, parameterSpecToJsonSchema };
