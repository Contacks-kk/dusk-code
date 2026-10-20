import type {LlmConfig} from "./config";
import type {
    ChatCompletionRequest,
    ChatCompletionResponse
} from "./role";

/** 调用大语言模型完成单轮对话 */
export async function chat(config:LlmConfig,input:string):Promise<string>{
    const request:ChatCompletionRequest={
        model:config.model,
        messages:[{
                role:"user",
                content:input
            },
        ],
        stream:false,
    };

    const url=`${config.baseurl.replace(/\/+$/,"")}/chat/completions`;
    const response=await fetch(url,{
        method:"POST",
        headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(60_000),
    })

    if(!response.ok){
        const errBody=await response.text();
        throw new Error(
            `LLM 请求失败(${response.status}):${errBody.slice(0,300)}`
        );
    }
    
    const data=(await response.json()) as ChatCompletionResponse;
    const answer=data.choices?.[0]?.message?.content;
    if(typeof answer !=="string"){
        throw new Error("model has not return content of text");
    }
    return answer;

}