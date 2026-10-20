import * as Readline from "readline";

class Solution{
    static merge(intervals :number[][]):number[][]{
        intervals.sort((a,b)=>(a[0]-b[0]));
        const ans:number[][]=[];
        for(const cur of intervals){
            let len:number=ans.length;
            if(len>0 && ans[len-1][1]>=cur[0]){
                // 能合并
                ans[len-1][1]=Math.max(ans[len-1][1],cur[1]);
            }else{
                // 不能合并 ，则新增
                ans.push(cur);
            }
        }
        return ans;
    }
}

const rl=Readline.createInterface({
    input:process.stdin,
    output:process.stdout
})

rl.question("请输入数组",(inputline)=>{
    const intervals:number[][]=JSON.parse(inputline.trim());
    console.log(intervals);
    console.log(Solution.merge(intervals));
    rl.close();
})