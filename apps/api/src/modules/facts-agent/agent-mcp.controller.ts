import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Public } from '../../auth/decorators';
import { AgentMcpService } from './agent-mcp.service';
import { AgentTokenGuard } from './agent-token.guard';

/**
 * 内部 agent 事实处理通道（独立于对外 /api/mcp）。
 * 只对本机/内网开放，写操作凭 x-agent-token 鉴权。
 */
@Controller('agent')
@UseGuards(AgentTokenGuard)
@Public()
export class AgentMcpController {
  constructor(private readonly agent: AgentMcpService) {}

  @Get('mcp')
  describe() {
    return {
      server: this.agent.serverInfo,
      protocolVersion: this.agent.protocolVersion,
      transport: 'http-jsonrpc',
      methods: ['initialize', 'ping', 'tools/list', 'tools/call'],
      note: '内部写通道：需要 x-agent-token；与对外 /api/mcp 隔离。',
      tools: this.agent.tools().map((t) => ({ name: t.name, description: t.description })),
    };
  }

  @Get('mcp/tools')
  tools() {
    return { tools: this.agent.tools() };
  }

  @Post('mcp')
  @HttpCode(200)
  rpc(@Body() body: unknown) {
    return this.agent.handle(body);
  }
}
