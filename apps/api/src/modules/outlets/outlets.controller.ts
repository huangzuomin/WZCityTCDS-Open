import { Controller, Get, Post, Req, Res, Query, Param } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../auth/decorators';
import { OutletsService } from './outlets.service';

/**
 * Public Outlets Controller (Slice R1)
 * Serves 7 authoritative public fact outlet channels guarded by Fail-Closed PublicationSecurityGate.
 */
@Controller('outlets')
@Public()
export class OutletsController {
  constructor(private readonly service: OutletsService) {}

  @Get('snapshot/:id')
  async getSnapshot(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const response = await this.service.handleRequest({
      method: 'GET',
      path: `/outlets/snapshot/${id}`,
      headers: req.headers as Record<string, string>,
    });
    this.sendResponse(res, response);
  }

  @Get('archive/:entityId')
  async getArchive(@Param('entityId') entityId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const response = await this.service.handleRequest({
      method: 'GET',
      path: `/outlets/archive/${entityId}`,
      headers: req.headers as Record<string, string>,
    });
    this.sendResponse(res, response);
  }

  @Get('jsonld/:id')
  async getJsonLd(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const response = await this.service.handleRequest({
      method: 'GET',
      path: `/outlets/jsonld/${id}`,
      headers: req.headers as Record<string, string>,
    });
    this.sendResponse(res, response);
  }

  @Get('feed.atom')
  async getFeed(@Req() req: Request, @Res() res: Response): Promise<void> {
    const response = await this.service.handleRequest({
      method: 'GET',
      path: '/outlets/feed.atom',
      headers: req.headers as Record<string, string>,
    });
    this.sendResponse(res, response);
  }

  @Get('sitemap.xml')
  async getSitemap(@Req() req: Request, @Res() res: Response): Promise<void> {
    const response = await this.service.handleRequest({
      method: 'GET',
      path: '/outlets/sitemap.xml',
      headers: req.headers as Record<string, string>,
    });
    this.sendResponse(res, response);
  }

  @Get('changes.ndjson')
  async getChanges(@Query('since_seq') sinceSeq: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const response = await this.service.handleRequest({
      method: 'GET',
      path: '/outlets/changes.ndjson',
      query: { since_seq: sinceSeq },
      headers: req.headers as Record<string, string>,
    });
    this.sendResponse(res, response);
  }

  @Post('mcp')
  async handleMcp(@Req() req: Request, @Res() res: Response): Promise<void> {
    const response = await this.service.handleRequest({
      method: 'POST',
      path: '/outlets/mcp',
      body: req.body,
      headers: req.headers as Record<string, string>,
    });
    this.sendResponse(res, response);
  }

  private sendResponse(
    res: Response,
    response: { statusCode: number; headers: Record<string, string>; body: string }
  ): void {
    res.status(response.statusCode);
    for (const [k, v] of Object.entries(response.headers)) {
      res.setHeader(k, v);
    }
    res.send(response.body);
  }
}
