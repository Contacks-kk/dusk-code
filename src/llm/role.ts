export interface ChatMessage{
    role:"user"|"assistant"|"system";
    content:string;
}

export interface ChatCompletionRequest{
    model:string;
    messages:ChatMessage[];
    stream:false;
}

export interface ChatCompletionResponse{
    choices:Array<{
        message:{
            role:"assistant",
            content:string|null
        };
        finish_reason:string|null;
    }>;
    created:number;
    id:string;
    model:string;
    object:"chat.completion";
    usage:{
        input_tokens:number;
        output_tokens:number;
    }
}   