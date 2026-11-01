import { Controller, Get, Header, NotFoundException, Param, ParseIntPipe, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../auth/decorators';
import { ArchiveService } from './archive.service';
import { BotVerifyService } from './bot-verify.service';
import { isBotUa, renderArticleSnapshotHtml } from './archive-html';
import { renderNotFoundHtml } from './aux-html';

/** 从请求推导对外 base（http/https + host），供 sitemap/canonical/快照链接使用 */
function baseUrlOf(req: Request): string {
  const proto = ((req.headers['x-forwarded-proto'] as string) ?? req.protocol ?? 'http').split(',')[0];
  const host = ((req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? 'localhost').split(',')[0];
  return `${proto}://${host}`;
}

/**
 * 客户端 IP：优先取 nginx 写入的 X-Real-IP。nginx 用 $remote_addr 覆盖该头，
 * 外部无法伪造；仅当直连 API 端口（本机 / 内网）时才回落到 socket 地址。
 */
function clientIpOf(req: Request): string {
  const real = ((req.headers['x-real-ip'] as string) ?? '').split(',')[0].trim();
  if (real) return real;
  const forwarded = ((req.headers['x-forwarded-for'] as string) ?? '').split(',')[0].trim();
  if (forwarded) return forwarded;
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

/**
 * 展示层读接口（公开，只读）。
 * 注意路由顺序：robots.txt / sitemap.xml / article/:id/raw 必须在 :dataset/:slug 之前注册。
 */
@Controller('archive')
@Public()
export class ArchiveController {
  constructor(
    private readonly service: ArchiveService,
    private readonly botVerify: BotVerifyService,
  ) {}

  /**
   * P1-2：服务端预渲染内容的放行判定。
   * 只有"声称自己是爬虫"的请求才需要反向 DNS 校验；判定为伪造则拒绝，
   * "无法校验"（未配置 PTR 域的爬虫 / DNS 无结果 / 内网来源）与校验通过都放行。
   */
  private async allowPrerender(req: Request): Promise<boolean> {
    const ua = req.headers['user-agent'] as string | undefined;
    return (await this.botVerify.verify(ua, clientIpOf(req))) !== 'denied';
  }

  /** 拒绝预渲染内容：既不给 HTML，也不给结构化 JSON（不提供比普通用户更多的数据） */
  private denyPrerender(res: Response) {
    res.status(403);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send('403 Forbidden：爬虫 UA 未通过反向 DNS 校验');
  }

  @Get('robots.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  robots(@Req() req: Request) {
    return this.service.robotsTxt(baseUrlOf(req));
  }

  @Get('sitemap.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  sitemapXml(@Req() req: Request) {
    return this.service.sitemapXml(baseUrlOf(req));
  }

  /** llms.txt：面向 AI 的站点使用说明（P2-5） */
  @Get('llms.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  llmsTxt(@Req() req: Request) {
    return this.service.llmsTxt(baseUrlOf(req));
  }

  /**
   * /api/archive/site：站点首页（爬虫 / ?format=html 直出 HTML，带 WebSite+Organization+Dataset；
   * 其余 UA 给 JSON 摘要）。必须注册在 :dataset/:slug 之前。
   */
  @Get('site')
  async site(@Req() req: Request, @Res() res: Response, @Query('format') format?: string) {
    const claimsBot = format === 'html' || isBotUa(req.headers['user-agent']);
    if (!claimsBot) {
      res.json(await this.service.siteSummary());
      return;
    }
    if (!(await this.allowPrerender(req))) {
      this.denyPrerender(res);
      return;
    }
    const { html, etag } = await this.service.siteHtml(baseUrlOf(req));
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.setHeader('Vary', 'User-Agent');
    res.type('html').send(html);
  }

  /** feed.json：近 30 天有变化的实体（GEO 变更枚举源） */
  @Get('feed.json')
  @Header('Cache-Control', 'public, max-age=600')
  feedJson() {
    return this.service.feedJson();
  }

  /** catalog.json：已发布实体目录（GEO 全量枚举源） */
  @Get('catalog.json')
  @Header('Cache-Control', 'public, max-age=3600')
  catalogJson() {
    return this.service.catalogJson();
  }

  /** feed.xml：事实变更订阅源（RSS 2.0） */
  @Get('feed.xml')
  @Header('Content-Type', 'application/rss+xml; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=600')
  feedXml(@Req() req: Request) {
    return this.service.feedXml(baseUrlOf(req));
  }

  /** 运行总览统计：公开的「抽取草稿 / 待人工复核」口径（排除图谱关系与实体候选） */
  @Get('stats/drafts')
  @Header('Cache-Control', 'public, max-age=60')
  draftStats() {
    return this.service.draftStats();
  }

  /**
   * 站点实体统计：SSG 与运行期共用的唯一实体口径。
   * 返回 publishedEntities（全部已发布实体，权威口径）、indexedEntities（进入 sitemap 索引的实体数）、
   * factCount（现行事实数）。须注册在 :dataset/:slug 之前。
   */
  @Get('stats/site')
  @Header('Cache-Control', 'public, max-age=60')
  siteStats() {
    return this.service.siteStats();
  }

  /** code.json：按 urn/code 的确定性 JSON 端点（/archive/:dataset/:slug.json） */
  @Get(':dataset/:slug.json')
  async pageJson(
    @Param('dataset') dataset: string,
    @Param('slug') slug: string,
    @Res() res: Response,
  ) {
    const data = await this.service.page(dataset, slug);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(data);
  }

  /**
   * SPA 兜底预检（第三阶段 soft-404 收紧）：/archive/:dataset/:slug 未命中 SSG 静态文件时，
   * 部署层 @archive_fallback 把请求代理到这里。
   * - 已发布实体 → 与 SSG/SSR 同源的完整 HTML（200；内容即静态文件，任何 UA，无 rDNS 门槛）
   * - 不存在/未发布 → 真 404 + 品牌 404 页（不再由 SPA 空壳冒充 200）
   */
  @Get('page/:dataset/:slug')
  async pageFallback(
    @Req() req: Request,
    @Param('dataset') dataset: string,
    @Param('slug') slug: string,
    @Res() res: Response,
  ) {
    const base = baseUrlOf(req);
    try {
      const { html, etag } = await this.service.pageHtml(dataset, slug, base);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=120');
      res.setHeader('ETag', etag);
      res.send(html);
    } catch (e) {
      if (e instanceof NotFoundException) {
        res
          .status(404)
          .setHeader('Content-Type', 'text/html; charset=utf-8')
          .setHeader('Cache-Control', 'no-store')
          .send(renderNotFoundHtml(base, `/archive/${dataset}/${slug}`));
        return;
      }
      throw e;
    }
  }

  /** 原文快照（证据溯源，noindex）：入库时存档的原文副本 */
  @Get('article/:id/raw')
  async articleRaw(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const a = await this.service.articleSnapshot(id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(renderArticleSnapshotHtml(a));
  }

  /**
   * 文章事实列表（须在 :dataset/:slug 之前注册）：
   * - 默认 JSON：这篇文章抽取的全部事实 + 实体关系一跳的相关事实
   * - ?format=html：同源 HTML（页面版，对应前台 /articles/{id}）
   */
  @Get('article/:id/facts')
  async articleFacts(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
    @Res() res: Response,
    @Query('format') format?: string,
  ) {
    if (format === 'html' || isBotUa(req.headers['user-agent'])) {
      const { html, etag } = await this.service.articleFactsPageHtml(id, baseUrlOf(req));
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('ETag', etag);
      res.send(html);
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(await this.service.articleFacts(id));
  }

  /**
   * 主题事实聚合（须在 :dataset/:slug 之前注册）：
   * - 默认 JSON：主题元信息 + 跨文章合并去重的事实 + 来源文章清单 + 主题核心数据
   * - ?format=html：同源 HTML（对应前台 /facts/{topicId}）
   */
  @Get('topic/:id/facts')
  async topicFacts(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
    @Res() res: Response,
    @Query('format') format?: string,
  ) {
    if (format === 'html' || isBotUa(req.headers['user-agent'])) {
      const { html, etag } = await this.service.topicPageHtml(id, baseUrlOf(req));
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('ETag', etag);
      res.send(html);
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(await this.service.topicFacts(id));
  }

  /**
   * 旧 /facts/{id} 链接解析（nginx 静态未命中时回源）：
   * - 命中主题 → 200：?format=html 返主题页本体（静态文件缺失时的兜底直出），否则返 JSON
   * - 命中文章 → 301 到该文章所属主题页
   * - 都没有 → 404
   */
  @Get('facts/:id/resolve')
  async factsResolve(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
    @Res() res: Response,
    @Query('format') format?: string,
  ) {
    const r = await this.service.resolveFactsRoute(id);
    if (r.kind === 'redirect') {
      // 前端 SPA 需要目标地址本身（不能被 301 到 HTML）：?format=json 时返回 JSON
      if (format === 'json') {
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json({ kind: 'redirect', location: r.location });
        return;
      }
      res.redirect(301, r.location);
      return;
    }
    if (r.kind === 'topic') {
      if (format === 'html' || isBotUa(req.headers['user-agent'])) {
        const { html, etag } = await this.service.topicPageHtml(r.topicId, baseUrlOf(req));
        if (req.headers['if-none-match'] === etag) {
          res.statusCode = 304;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('ETag', etag);
        res.send(html);
        return;
      }
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ kind: 'topic', topicId: r.topicId, url: `/facts/${r.topicId}` });
      return;
    }
    res.status(404).json({ kind: 'missing' });
  }

  /** 语料域首页：按关联分类目录组织的实体卡片（须在 :dataset/:slug 之前注册） */
  @Get('home/:dataset')
  async home(@Param('dataset') dataset: string, @Res() res: Response) {
    const data = await this.service.home(dataset);
    // 首页是动态数据（后台改 homeShow/目录实时生效），不缓存；否则浏览器 5 分钟内一直吃旧数据
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  }

  /** 语料域公开图谱（前台只读浏览，须在 :dataset/:slug 之前注册） */
  @Get(':dataset/graph')
  async datasetGraph(@Param('dataset') dataset: string, @Res() res: Response, @Query('limit') limit?: string) {
    const data = await this.service.datasetGraph(dataset, limit ? Number(limit) : 80);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(data);
  }

  /**
   * 语料域内实体多跳子图（公开图谱页扩跳用；仅该语料域已发布实体）。
   * 同样必须在 :dataset/:slug 之前注册。
   */
  @Get(':dataset/graph/entity/:entityId')
  async datasetEntityGraph(
    @Param('dataset') dataset: string,
    @Param('entityId', ParseIntPipe) entityId: number,
    @Res() res: Response,
    @Query('depth') depth?: string,
  ) {
    const data = await this.service.datasetEntityGraph(dataset, entityId, depth ? Number(depth) : 3);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(data);
  }

  /**
   * 档案页数据：
   * - 默认 JSON（SPA 用）
   * - ?format=html 或爬虫 UA → 服务端渲染完整 HTML（含 JSON-LD，附 ETag/缓存头）
   *   部署层可把 /archive/:dataset/:slug 的爬虫流量代理到这里，实现「机器可读」
   */
  @Get(':dataset/:slug')
  async page(
    @Req() req: Request,
    @Res() res: Response,
    @Param('dataset') dataset: string,
    @Param('slug') slug: string,
    @Query('format') format?: string,
  ) {
    const claimsBot = format === 'html' || isBotUa(req.headers['user-agent']);
    if (!claimsBot) {
      // JSON 版（保持原有行为）
      const data = await this.service.page(dataset, slug);
      res.json(data);
      return;
    }
    // P1-2：自称爬虫的必须通过反向 DNS 校验，否则不给预渲染 HTML
    if (!(await this.allowPrerender(req))) {
      this.denyPrerender(res);
      return;
    }
    const { html, etag } = await this.service.pageHtml(dataset, slug, baseUrlOf(req));
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Vary', 'User-Agent');
    res.setHeader('ETag', etag);
    res.send(html);
  }

  /** 单条事实的稳定公开地址：/archive/:dataset/:slug/fact/:code（JSON，可引用/可收藏） */
  @Get(':dataset/:slug/fact/:code')
  factByCode(
    @Param('dataset') dataset: string,
    @Param('slug') slug: string,
    @Param('code') code: string,
  ) {
    return this.service.factByCode(dataset, slug, code);
  }

  /** 单条变更的稳定公开地址：/archive/:dataset/:slug/change/:id（JSON，可引用/可收藏） */
  @Get(':dataset/:slug/change/:id')
  changeByCode(
    @Param('dataset') dataset: string,
    @Param('slug') slug: string,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.changeById(dataset, slug, id);
  }

  @Get(':dataset/:slug/facts')
  facts(@Param('dataset') dataset: string, @Param('slug') slug: string) {
    return this.service.page(dataset, slug).then((p) => ({
      entity: p.entity,
      facts: p.facts,
      superseded: p.superseded,
      changes: p.changes,
    }));
  }

  @Get(':dataset/:slug/evidence')
  evidence(@Param('dataset') dataset: string, @Param('slug') slug: string) {
    return this.service.page(dataset, slug).then((p) => ({
      entity: p.entity,
      evidence: p.evidence,
      articles: p.articles,
    }));
  }
}
