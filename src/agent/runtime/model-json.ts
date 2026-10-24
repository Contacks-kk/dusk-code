/** 提取模型返回的完整 JSON 对象，允许对象外附带代码围栏或说明 */
export function parseModelObject(text: string): { value: unknown; extracted: boolean } {
    const trimmed = text.trim();
    const start = trimmed.indexOf("{");
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; start >= 0 && index < trimmed.length; index++) {
        const character = trimmed[index];
        if (quoted) {
            if (escaped) {
                escaped = false;
            } else if (character === "\\") {
                escaped = true;
            } else if (character === '"') {
                quoted = false;
            }
            continue;
        }
        if (character === '"') {
            quoted = true;
        } else if (character === "{") {
            depth++;
        } else if (character === "}" && --depth === 0) {
            return { value: JSON.parse(trimmed.slice(start, index + 1)), extracted: start !== 0 || index !== trimmed.length - 1 };
        }
    }
    throw new Error("模型没有返回完整的 JSON 对象");
}
