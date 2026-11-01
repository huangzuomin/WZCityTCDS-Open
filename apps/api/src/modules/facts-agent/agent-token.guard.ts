import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * 内部 agent 通道鉴权：请求头 x-agent-token 必须等于环境变量 AGENT_MCP_TOKEN。
 * 未配置 token 时一律拒绝（安全默认），避免误开写入口。
 */
@Injectable()
export class AgentTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const expected = process.env.AGENT_MCP_TOKEN;
    const provided = req.headers['x-agent-token'];
    if (!expected || typeof provided !== 'string' || provided.length !== expected.length || provided !== expected) {
      throw new UnauthorizedException('AGENT_MCP_TOKEN 缺失或不匹配');
    }
    return true;
  }
}
