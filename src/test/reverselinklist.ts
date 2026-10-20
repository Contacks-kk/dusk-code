import { link } from "node:fs";
import * as readline from "readline"
export class LinkNode{
    val:number;
    next:LinkNode|null;

    constructor(val:number,next:LinkNode|null=null){
        this.val=(val===undefined)?0:val;
        this.next=(next===undefined)?null:next;
    }
}

function reverseKGroup(head:LinkNode|null,k:number):LinkNode|null{
    let cur:LinkNode|null=head;
    let len:number=0;
    while(cur!=null){
        len++;
        cur=cur.next;
    }
    cur=head;
    let dummy =new LinkNode(0,head);
    let prev:LinkNode|null=dummy;
    const cnt=Math.floor(len/k);
    for(let i=0;i<cnt;i++){
        let  tmp:LinkNode|null=null;
        for(let j=1;j<k;j++){
            tmp=cur!.next!;
            cur!.next=tmp.next;
            tmp.next=prev.next;
            prev.next=tmp;
        }
        prev=cur!;
        cur=cur!.next;
    }
    return dummy.next;
}

// 辅助打印函数：将链表转为数组输出
function printList(head: LinkNode | null): number[] {
  const res: number[] = [];
  let curr = head;
  while (curr !== null) {
    res.push(curr.val);
    curr = curr.next;
  }
  return res;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("请输入内容（数字以空格隔开，如 1 2 3 4 5）: ", (inputstr) => {
  const trimmed = inputstr.trim();
  if (!trimmed) {
    rl.close();
    return;
  }

  const arr = trimmed.split(/\s+/).map(Number);
  const head = new LinkNode(arr[0]);
  let cur = head;
  for (let i = 1; i < arr.length; i++) {
    cur.next = new LinkNode(arr[i]);
    cur = cur.next;
  }

  const k = 3;
  const result = reverseKGroup(head, k);

  console.log("翻转后的链表结果:", printList(result));
  rl.close();
});