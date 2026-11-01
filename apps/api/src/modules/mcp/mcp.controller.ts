import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Public } from '../../auth/decorators';
import { McpService } from './mcp.service';

/**
 * MCP 只读工具服务（公开，无需登录）。
 * 对外文档口径：POST /api/mcp（JSON-RPC 2.0）。
 */
@Controller()
@Public()
export class McpController {
  constructor(private readonly mcp: McpService) {}

  /** GET /api/mcp：服务说明与工具清单摘要 */
  @Get('mcp')
  describe() {
    return this.mcp.describe();
  }

  /** GET /api/mcp/tools：工具定义（tools/list 的 REST 形式，供管理端展示） */
  @Get('mcp/tools')
  tools() {
    return { tools: this.mcp.tools() };
  }

  /** POST /api/mcp：JSON-RPC 2.0（initialize / ping / tools/list / tools/call） */
  @Post('mcp')
  @HttpCode(200)
  rpc(@Body() body: unknown) {
    return this.mcp.handle(body);
  }
}
