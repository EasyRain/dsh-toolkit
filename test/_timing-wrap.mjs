// 给某份自测的每一条输出来加上“距开始多少秒”的前缀（不改被测文件本身）
const t0 = Date.now()
const tag = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`
const origLog = console.log
console.log = (...a) => origLog(tag(), ...a)
process.on('exit', () => origLog(tag(), '=== exit ==='))
await import(process.argv[2])
