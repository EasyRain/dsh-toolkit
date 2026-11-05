/** 工具层错误（宿主会把它显示成"工具执行失败"，而不是插件崩溃）。 */
export class ToolError extends Error {
    constructor(message) {
        super(message)
        this.name = 'ToolError'
    }
}
