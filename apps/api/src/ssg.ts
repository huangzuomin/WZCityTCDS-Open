/**
 * SSG 构建脚本：把全部已发布档案页预渲染成静态 HTML。
 *
 * 背景（技术债清偿）：线上 /archive/* 目前按 UA 白名单分流——白名单内爬虫经
 * API SSR 拿完整预渲染页，其余 UA 只得 416B SPA 空壳。本脚本复用
 * ArchiveService.pageHtml()（与 SSR 完全同一渲染函数）批量产出静态文件，
 * 部署层用 nginx try_files 静态优先直出，即可让任何 UA 无差别读到完整内容。
 *
 * 用法（先 pnpm build）：
 *   node dist/ssg.js --base https://facts.66wz.com
 *   node dist/ssg.js --base https://facts.66wz.com --incremental   # 只重渲染有变化的实体
 *   node dist/ssg.js --base https://facts.66wz.com --out /var/www/SSOT/ssg
 *
 * 产物结构：
 *   {out}/archive/{dataset}/{slug}/index.html   档案页（canonical 与线上路由一致）
 *   {out}/archive/home/{dataset}/index.html     语料域首页（第三阶段辅助路由 SSG）
 *   {out}/{overview,catalog,news,changes}/index.html  辅助路由静态页（注入 SPA 资源，JS 启用时升级交互版）
 *   {out}/{topics,facts,publications,distribution,observatory}/index.html  内容视图静态页（同辅助路由口径）
 *   {out}/sitemap.xml {out}/robots.txt {out}/llms.txt {out}/methodology/index.html
 *   {out}/.manifest.json                        dataset/slug -> lastmod 清单（增量依据）
 *
 * 增量原理：ArchiveService.sitemap() 的 lastmod 取现行事实与变更流的较新者，
 * 与 .manifest.json 对比，lastmod 未变的实体跳过重渲染（页内容只随事实变化）。
 * 实体下线（不在 sitemap 清单中）时删除其静态文件，避免留下 soft-404 孤儿页。
 */
import { NestFactory } from '@nestjs/core';
import { NotFoundException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppModule } from './app.module';
import { ArchiveService } from './modules/archive/archive.service';
import { DiscoveryService } from './modules/discovery/discovery.service';
import { renderMethodologyHtml } from './modules/archive/methodology-html';
import {
  renderCatalogHtml,
  renderChangesHtml,
  renderDatasetHomeHtml,
  renderNewsHtml,
  renderOverviewHtml,
} from './modules/archive/aux-html';
import {
  renderDistributionHtml,
  renderFactsHtml,
  renderObservatoryHtml,
  renderPublicationsHtml,
  renderTopicsHtml,
} from './modules/archive/aux-html-pages';
import { ObservatoryService } from './modules/observatory/observatory.service';
import { McpService } from './modules/mcp/mcp.service';

interface Args {
  base: string;
  out: string;
  incremental: boolean;
  concurrency: number;
  noPrune: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) return undefined;
    return v;
  };
  const base = get('base') ?? process.env.SITE_BASE_URL;
  if (!base) {
    console.error('缺少 --base <https://facts.66wz.com>（或环境变量 SITE_BASE_URL）');
    process.exit(2);
  }
  return {
    base: base.replace(/\/+$/, ''),
    out: path.resolve(get('out') ?? path.join(__dirname, '..', '..', 'ssg')),
    incremental: argv.includes('--incremental'),
    concurrency: Math.max(1, Number(get('concurrency') ?? 6)),
    noPrune: argv.includes('--no-prune'),
  };
}

/** 单文件原子写：先写临时文件再 rename，读方永远不会看到半截 HTML */
function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * 从前台构建产物（apps/web/dist/index.html）提取 SPA 资源标签（样式 + module 脚本）。
 * 注入辅助路由静态页后：启用 JS 的浏览器由 Vue 挂载 #app 替换静态内容，
 * 无缝升级为交互版（搜索/筛选）；禁 JS 或爬虫保持静态全量内容。
 * web 重新部署后 hash 变化，下一轮 SSG（cron ≤10 分钟）自动刷新引用。
 */
function extractSpaAssets(webDist: string): string {
  try {
    const html = fs.readFileSync(path.join(webDist, 'index.html'), 'utf8');
    const tags: string[] = [];
    for (const m of html.matchAll(/<link[^>]+rel="(?:stylesheet|modulepreload)"[^>]*>/g)) tags.push(m[0]);
    for (const m of html.matchAll(/<script[^>]+type="module"[^>]*src="[^"]+"[^>]*>\s*<\/script>/g)) tags.push(m[0]);
    return tags.join('\n');
  } catch {
    return ''; // web dist 缺失时退化为纯静态页（仍完整可读）
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  // standalone 应用上下文：不监听端口、不走 HTTP，直接从容器拿 service
  // （因此也不经过 controller 的 UA 判断与 rDNS 校验——SSG 本来就该全量渲染）
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const svc = app.get(ArchiveService);

  const manifestFile = path.join(args.out, '.manifest.json');
  const prevManifest: Record<string, string> = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    : {};

  const rows = await svc.sitemap(); // [{datasetCode, slug, updatedAt}] 已发布实体
  const keyOf = (d: string, s: string) => `${d}/${s}`;
  const nextManifest: Record<string, string> = {};

  // 待渲染集：全量模式无条件重渲染；增量模式只挑 lastmod 变化的（manifest 缺项视为变化）
  const todo = rows.filter((r) => {
    const key = keyOf(r.datasetCode, r.slug);
    const changed = prevManifest[key] !== r.updatedAt;
    nextManifest[key] = r.updatedAt;
    return args.incremental ? changed : true;
  });

  let rendered = 0;
  const skippedStale = rows.length - todo.length;
  let missing = 0;
  const errors: string[] = [];

  // SPA 资源标签（web dist 提取）：注入实体页与辅助页——启用 JS 的浏览器由 Vue 挂载
  // #app 替换静态内容，自动升级为交互版；爬虫 / 禁 JS 环境直读静态全量内容
  const spaAssets = extractSpaAssets(path.join(__dirname, '..', '..', 'web', 'dist'));

  // 简单并发池（不引依赖）：SSR 每页要打数个 DB 查询，并发过高会压连接池
  const queue = [...todo];
  const worker = async (): Promise<void> => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      const { datasetCode, slug } = row;
      const file = path.join(args.out, 'archive', datasetCode, slug, 'index.html');
      try {
        const { html } = await svc.pageHtml(datasetCode, slug, args.base, spaAssets);
        writeFileAtomic(file, html);
        rendered++;
      } catch (e) {
        if (e instanceof NotFoundException) {
          // sitemap 清单与 pageHtml 之间存在数据竞争（如正好被下线）：跳过并从清单剔除
          missing++;
          delete nextManifest[keyOf(datasetCode, slug)];
        } else {
          errors.push(`${datasetCode}/${slug}: ${(e as Error).message}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, worker));

  // 清理孤儿：上次生成过、这次不在 sitemap 清单里的实体（下线/合并），删文件防 soft-404
  let pruned = 0;
  if (!args.noPrune) {
    for (const key of Object.keys(prevManifest)) {
      if (nextManifest[key]) continue;
      const [d, s] = key.split('/');
      const dir = path.join(args.out, 'archive', d, s);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
        pruned++;
      }
    }
    // 顺带清掉空 dataset 目录
    const archDir = path.join(args.out, 'archive');
    if (fs.existsSync(archDir)) {
      for (const d of fs.readdirSync(archDir)) {
        const dp = path.join(archDir, d);
        if (fs.existsSync(dp) && fs.readdirSync(dp).length === 0) fs.rmdirSync(dp);
      }
    }
  }

  // ---- 单条事实页 SSG：/archive/{dataset}/{slug}/fact/{code} ----
  // 独立清单（.facts-manifest.json）：与实体页互不影响，增量模式只重渲染变化的事实。
  // 这些页面同时进入 sitemap，供外部稳定引用单条事实。
  const factManifestFile = path.join(args.out, '.facts-manifest.json');
  const prevFactManifest: Record<string, string> = fs.existsSync(factManifestFile)
    ? JSON.parse(fs.readFileSync(factManifestFile, 'utf8'))
    : {};
  const nextFactManifest: Record<string, string> = {};
  const fkeyOf = (d: string, s: string, c: string) => `${d}/${s}/fact/${c}`;
  let factRendered = 0;
  let factSkipped = 0;
  let factPruned = 0;
  try {
    const factRows = await svc.factPages();
    const ftodo = factRows.filter((r) => {
      const key = fkeyOf(r.datasetCode, r.slug, r.code);
      const changed = prevFactManifest[key] !== r.updatedAt;
      nextFactManifest[key] = r.updatedAt ?? '';
      return args.incremental ? changed : true;
    });
    factSkipped = factRows.length - ftodo.length;
    const fqueue = [...ftodo];
    const fworker = async (): Promise<void> => {
      for (;;) {
        const row = fqueue.shift();
        if (!row) return;
        try {
          const { html } = await svc.factPageHtml(row.datasetCode, row.slug, row.code, args.base, spaAssets);
          writeFileAtomic(
            path.join(args.out, 'archive', row.datasetCode, row.slug, 'fact', row.code, 'index.html'),
            html,
          );
          factRendered++;
        } catch (e) {
          if (e instanceof NotFoundException) {
            // 数据竞争（正好被取代/下线）：跳过并从清单剔除
            delete nextFactManifest[fkeyOf(row.datasetCode, row.slug, row.code)];
          } else {
            errors.push(`fact ${row.datasetCode}/${row.slug}/${row.code}: ${(e as Error).message}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: args.concurrency }, fworker));

    // 清理失效事实页（被取代 / 下线 / 编号变化）
    if (!args.noPrune) {
      for (const key of Object.keys(prevFactManifest)) {
        if (nextFactManifest[key] !== undefined) continue;
        const [d, s, , c] = key.split('/');
        const dir = path.join(args.out, 'archive', d, s, 'fact', c);
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true });
          factPruned++;
        }
      }
    }
    writeFileAtomic(factManifestFile, JSON.stringify(nextFactManifest, null, 2));
  } catch (e) {
    errors.push(`单条事实页 SSG: ${(e as Error).message}`);
  }

  // ---- 单条变更记录页 SSG：/archive/{dataset}/{slug}/change/{id} ----
  // 独立清单（.changes-manifest.json）。比对值用 changePages() 给出的 signature
  // （含 md5(summary)）——fact_change 没有 updated_at，靠摘要哈希才能感知内容变化。
  const changeManifestFile = path.join(args.out, '.changes-manifest.json');
  const prevChangeManifest: Record<string, string> = fs.existsSync(changeManifestFile)
    ? JSON.parse(fs.readFileSync(changeManifestFile, 'utf8'))
    : {};
  const nextChangeManifest: Record<string, string> = {};
  const ckeyOf = (d: string, s: string, id: number) => `${d}/${s}/change/${id}`;
  let changeRendered = 0;
  let changeSkipped = 0;
  let changePruned = 0;
  try {
    const changeRows = await svc.changePages();
    const ctodo = changeRows.filter((r) => {
      const key = ckeyOf(r.datasetCode, r.slug, r.id);
      const changed = prevChangeManifest[key] !== r.signature;
      nextChangeManifest[key] = r.signature;
      return args.incremental ? changed : true;
    });
    changeSkipped = changeRows.length - ctodo.length;
    const cqueue = [...ctodo];
    const cworker = async (): Promise<void> => {
      for (;;) {
        const row = cqueue.shift();
        if (!row) return;
        try {
          const { html } = await svc.changePageHtml(row.datasetCode, row.slug, row.id, args.base, spaAssets);
          writeFileAtomic(
            path.join(args.out, 'archive', row.datasetCode, row.slug, 'change', String(row.id), 'index.html'),
            html,
          );
          changeRendered++;
        } catch (e) {
          if (e instanceof NotFoundException) {
            delete nextChangeManifest[ckeyOf(row.datasetCode, row.slug, row.id)];
          } else {
            errors.push(`change ${row.datasetCode}/${row.slug}/${row.id}: ${(e as Error).message}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: args.concurrency }, cworker));

    if (!args.noPrune) {
      for (const key of Object.keys(prevChangeManifest)) {
        if (nextChangeManifest[key] !== undefined) continue;
        const [d, s, , id] = key.split('/');
        const dir = path.join(args.out, 'archive', d, s, 'change', id);
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true });
          changePruned++;
        }
      }
    }
    writeFileAtomic(changeManifestFile, JSON.stringify(nextChangeManifest, null, 2));
  } catch (e) {
    errors.push(`单条变更页 SSG: ${(e as Error).message}`);
  }

  // ---- 文章事实稿页 SSG：/articles/{articleId} ----
  // 独立清单（.articles-manifest.json）。这类页面的主体是「一篇文章抽出了哪些事实」，
  // 变化来源是事实更新、证据增加，或文章主题/摘要被生产线回填，故 signature 含
  // facts 数量 + 最新时间 + md5(主题+摘要)，三者任一变动都会触发重渲染。
  // 注意：/facts/{id} 现在归主题页所有，文章页迁到 /articles/{id}。
  const articleManifestFile = path.join(args.out, '.articles-manifest.json');
  const prevArticleManifest: Record<string, string> = fs.existsSync(articleManifestFile)
    ? JSON.parse(fs.readFileSync(articleManifestFile, 'utf8'))
    : {};
  const nextArticleManifest: Record<string, string> = {};
  let articleRendered = 0;
  let articleSkipped = 0;
  let articlePruned = 0;
  try {
    const articleRows = await svc.articleFactPages();
    const atodo = articleRows.filter((r) => {
      const key = String(r.articleId);
      const changed = prevArticleManifest[key] !== r.signature;
      nextArticleManifest[key] = r.signature;
      return args.incremental ? changed : true;
    });
    articleSkipped = articleRows.length - atodo.length;
    const aqueue = [...atodo];
    const aworker = async (): Promise<void> => {
      for (;;) {
        const row = aqueue.shift();
        if (!row) return;
        try {
          // 文章事实稿是独立整页版式：不注入 SPA 资源（否则会被前台框架接管换样式）
          const { html } = await svc.articleFactsPageHtml(row.articleId, args.base);
          writeFileAtomic(path.join(args.out, 'articles', String(row.articleId), 'index.html'), html);
          articleRendered++;
        } catch (e) {
          if (e instanceof NotFoundException) {
            delete nextArticleManifest[String(row.articleId)];
          } else {
            errors.push(`article ${row.articleId}: ${(e as Error).message}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: args.concurrency }, aworker));

    // 清理失效文章页（文章被删 / 事实全部下线）
    if (!args.noPrune) {
      for (const key of Object.keys(prevArticleManifest)) {
        if (nextArticleManifest[key] !== undefined) continue;
        const dir = path.join(args.out, 'articles', key);
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true });
          articlePruned++;
        }
      }
    }
    writeFileAtomic(articleManifestFile, JSON.stringify(nextArticleManifest, null, 2));
  } catch (e) {
    errors.push(`文章事实页 SSG: ${(e as Error).message}`);
  }

  // ---- 主题聚合页 SSG：/facts/{topicId} ----
  // 独立清单（.topics-manifest.json）。签名含事实数、最新事实时间与 md5(主题名+定义)，
  // 生产线回填主题、事实增删都会触发重渲染。
  const topicManifestFile = path.join(args.out, '.topics-manifest.json');
  const prevTopicManifest: Record<string, string> = fs.existsSync(topicManifestFile)
    ? JSON.parse(fs.readFileSync(topicManifestFile, 'utf8'))
    : {};
  const nextTopicManifest: Record<string, string> = {};
  let topicRendered = 0;
  let topicSkipped = 0;
  let topicPruned = 0;
  let legacyFactsPruned = 0;
  try {
    const topicRows = await svc.topicPages();
    const ttodo = topicRows.filter((r) => {
      const key = String(r.topicId);
      const changed = prevTopicManifest[key] !== r.signature;
      nextTopicManifest[key] = r.signature;
      return args.incremental ? changed : true;
    });
    topicSkipped = topicRows.length - ttodo.length;
    const tqueue = [...ttodo];
    const tworker = async (): Promise<void> => {
      for (;;) {
        const row = tqueue.shift();
        if (!row) return;
        try {
          const { html } = await svc.topicPageHtml(row.topicId, args.base);
          writeFileAtomic(path.join(args.out, 'facts', String(row.topicId), 'index.html'), html);
          topicRendered++;
        } catch (e) {
          if (e instanceof NotFoundException) {
            delete nextTopicManifest[String(row.topicId)];
          } else {
            errors.push(`topic ${row.topicId}: ${(e as Error).message}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: args.concurrency }, tworker));

    if (!args.noPrune) {
      for (const key of Object.keys(prevTopicManifest)) {
        if (nextTopicManifest[key] !== undefined) continue;
        const dir = path.join(args.out, 'facts', key);
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true });
          topicPruned++;
        }
      }
    }
    writeFileAtomic(topicManifestFile, JSON.stringify(nextTopicManifest, null, 2));
  } catch (e) {
    errors.push(`主题事实页 SSG: ${(e as Error).message}`);
  }

  // ---- 旧 /facts/{articleId} 目录清理 ----
  // 这些路径现在归主题页所有；上一个版本的文章页目录必须删掉，否则会与同号主题页串页。
  // 若同号主题页存在（nextTopicManifest 命中），目录已被主题页重写，不能删。
  if (!args.noPrune) {
    for (const key of Object.keys(prevArticleManifest)) {
      if (nextTopicManifest[key] !== undefined) continue;
      const dir = path.join(args.out, 'facts', key);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
        legacyFactsPruned++;
      }
    }
  }

  // 站点级产物：sitemap / robots / llms.txt 与档案页同源，一并静态化（失败不阻塞档案页交付）
  try {
    writeFileAtomic(path.join(args.out, 'sitemap.xml'), await svc.sitemapXml(args.base));
    writeFileAtomic(path.join(args.out, 'robots.txt'), svc.robotsTxt(args.base));
    writeFileAtomic(path.join(args.out, 'llms.txt'), svc.llmsTxt(args.base));
    // 方法论页（E-E-A-T）：纯静态内容不依赖 DB，每轮直接重写，进 sitemap 与 llms.txt
    writeFileAtomic(path.join(args.out, 'methodology', 'index.html'), renderMethodologyHtml(args.base));
  } catch (e) {
    errors.push(`站点级产物(sitemap/robots/llms/methodology): ${(e as Error).message}`);
  }

  // 站点实体统计：唯一口径（已发布实体 / 进入索引的实体 / 现行事实），本处只计算一次，
  // 供 /catalog 与 /distribution 复用；/overview 走 siteSummary()，同样基于 siteStats()。
  const siteStats = await svc.siteStats();

  // ---- 辅助路由 SSG（第三阶段）：/overview /catalog /news /changes + 语料域首页 ----
  // 这些页面数据量小、查询便宜，每轮全量重写（不走 manifest 增量）；
  // 注入 web dist 的 SPA 资源标签，启用 JS 的浏览器自动升级为交互版。
  let auxCount = 0;
  try {
    // /overview：站点总览（复用 siteSummary 口径）
    writeFileAtomic(
      path.join(args.out, 'overview', 'index.html'),
      renderOverviewHtml(args.base, await svc.siteSummary(), spaAssets),
    );
    auxCount++;

    // /catalog：全量实体目录（catalogJson 与 /catalog.json 同源，含类别分组）；
    // 实体总数传入 siteStats() 的唯一口径，避免与 entries.length 各自定义
    writeFileAtomic(
      path.join(args.out, 'catalog', 'index.html'),
      renderCatalogHtml(args.base, await svc.catalogJson(), spaAssets, siteStats),
    );
    auxCount++;

    // /changes：最近 50 条事实变更
    const changes = await svc.listChangesPage(1, 50);
    writeFileAtomic(
      path.join(args.out, 'changes', 'index.html'),
      renderChangesHtml(args.base, changes.items as unknown as Record<string, unknown>[], spaAssets),
    );
    auxCount++;

    // /news：实时新闻流（discovery 记录，按发布时间倒序）
    const discovery = app.get(DiscoveryService);
    const news = await discovery.listRecords({ page: 1, pageSize: 50, orderBy: 'pubDate' });
    writeFileAtomic(
      path.join(args.out, 'news', 'index.html'),
      renderNewsHtml(args.base, news.items as unknown as Record<string, unknown>[], spaAssets),
    );
    auxCount++;

    // 语料域首页 /archive/home/{code}：目录卡片 + 统计 + 最近变更（sitemap 已收录）
    const datasetCodes = [...new Set(rows.map((r) => r.datasetCode))].filter(Boolean);
    for (const code of datasetCodes) {
      const home = await svc.home(code);
      writeFileAtomic(
        path.join(args.out, 'archive', 'home', code, 'index.html'),
        renderDatasetHomeHtml(args.base, home, spaAssets),
      );
      auxCount++;
    }
  } catch (e) {
    errors.push(`辅助路由 SSG: ${(e as Error).message}`);
  }

  // ---- 内容视图 SSG（第四阶段）：/topics /facts /publications /distribution /observatory ----
  // 这 5 条路由与左侧菜单入口一一对应，此前只在 SPA 内渲染，对不执行 JS 的爬虫返回空壳。
  // 与辅助路由同口径：数据量可控，每轮全量重写，不参与 manifest 增量。
  let contentCount = 0;
  try {
    // /topics：实体与主题（按一级主题组织的实体索引，与 /catalog 同源）
    const catalog = await svc.catalogJson();
    writeFileAtomic(
      path.join(args.out, 'topics', 'index.html'),
      renderTopicsHtml(args.base, catalog, spaAssets),
    );
    contentCount++;

    // /facts：最近核验的现行事实（附实体名与单条事实页入口）
    writeFileAtomic(
      path.join(args.out, 'facts', 'index.html'),
      renderFactsHtml(args.base, await svc.factsPage(60), spaAssets),
    );
    contentCount++;

    // /publications：按来源文章归集的发布记录
    const publications = await svc.listPublicationPage(1, 30);
    writeFileAtomic(
      path.join(args.out, 'publications', 'index.html'),
      renderPublicationsHtml(
        args.base,
        publications.groups as unknown as Record<string, unknown>[],
        spaAssets,
      ),
    );
    contentCount++;

    // /observatory：固定问题集的真实引用观测快照
    const observatory = app.get(ObservatoryService);
    writeFileAtomic(
      path.join(args.out, 'observatory', 'index.html'),
      renderObservatoryHtml(args.base, await observatory.getSnapshot(), spaAssets),
    );
    contentCount++;

    // /distribution：机器出口清单（MCP 工具来自真实注册表）；
    // 统计数字统一取 siteStats()（已发布实体 / 现行事实），不再由 catalog 数组另算
    const mcp = app.get(McpService);
    writeFileAtomic(
      path.join(args.out, 'distribution', 'index.html'),
      renderDistributionHtml(
        args.base,
        {
          entityCount: siteStats.publishedEntities,
          factCount: siteStats.factCount,
          tools: mcp.tools().map((t) => ({ name: t.name, description: t.description })),
        },
        spaAssets,
      ),
    );
    contentCount++;
  } catch (e) {
    errors.push(`内容视图 SSG: ${(e as Error).message}`);
  }

  writeFileAtomic(manifestFile, JSON.stringify(nextManifest, null, 2));
  await app.close(); // 释放 MySQL 连接，否则进程不退出

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[ssg] base=${args.base} out=${args.out} 实体=${rows.length} 渲染=${rendered}` +
      ` 未变跳过=${skippedStale} 404跳过=${missing} 清理=${pruned} 辅助页=${auxCount} 内容页=${contentCount}` +
      ` 事实页=${factRendered} 事实未变=${factSkipped} 事实清理=${factPruned}` +
      ` 变更页=${changeRendered} 变更未变=${changeSkipped} 变更清理=${changePruned}` +
      ` 文章事实页=${articleRendered} 文章未变=${articleSkipped} 文章清理=${articlePruned}` +
      ` 主题事实页=${topicRendered} 主题未变=${topicSkipped} 主题清理=${topicPruned} 旧文章页清理=${legacyFactsPruned} 耗时=${secs}s` +
      (args.incremental ? ' (增量)' : ' (全量)'),
  );
  if (errors.length) {
    console.error(`[ssg] ${errors.length} 个错误：\n  ${errors.slice(0, 20).join('\n  ')}`);
    process.exitCode = 1;
  }
  // 兜底退出：app.close() 后仍可能有未释放句柄（连接池 keepalive/定时器）导致进程悬挂，
  // cron 场景下悬挂实例会越积越多。所有输出后强制退出。
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('[ssg] 构建失败：', e);
  process.exit(1);
});
