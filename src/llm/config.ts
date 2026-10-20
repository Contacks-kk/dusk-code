export interface LlmConfig{
    baseurl:string;
    model:string
    apiKey:string;
}

/** 加载并校验大语言模型配置 */
export function loadLlmConfig():LlmConfig{
    const baseurl=process.env.LLM_BASE_URL;
    const model=process.env.LLM_MODEL;
    const apiKey=process.env.LLM_API_KEY;
    if(!baseurl||!model||!apiKey){
        throw new Error("请配置完整的LLM环境变量")
    }
    return {baseurl,model,apiKey}
}