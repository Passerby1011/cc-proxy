// 测试文本分割函数
const text = "根据最新的搜索结果，关于 DeepSeek V4 的信息如下：";

const chunks: string[] = [];
const words = text.split(/(\s+)/); // 保留空格

console.log("Words:", words);
console.log("Words count:", words.length);

for (const word of words) {
  // 中文字符按字分割，英文单词整体输出
  if (/[\u4e00-\u9fa5]/.test(word)) {
    for (const char of word) {
      chunks.push(char);
    }
  } else {
    chunks.push(word);
  }
}

console.log("\nChunks:", chunks);
console.log("Chunks count:", chunks.length);
console.log("Joined:", chunks.join(""));
console.log("Original:", text);
console.log("Match:", chunks.join("") === text);
