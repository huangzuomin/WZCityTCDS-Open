import {
  HubEntityAdapter,
  MockHubEntityTransport,
  assertValidEntityId,
} from './hub-entity.js';
import {
  MatchedEntity,
  ProposalSourceEvidence,
  UnresolvedEntityProposal,
} from '../contracts/index.js';

export async function runHubEntityAdapterTests(): Promise<{ passed: number; total: number; errors: string[] }> {
  const errors: string[] = [];
  let passed = 0;
  let total = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    total++;
    try {
      await fn();
      passed++;
    } catch (err: any) {
      errors.push(`[${name}]: ${err.message}`);
    }
  }

  // 1. assertValidEntityId
  await test('assertValidEntityId - accepts valid entity IDs and rejects invalid ones', () => {
    assertValidEntityId('ent_wz_lucheng_gov_001');
    assertValidEntityId('ent_abcdef123');
    assertValidEntityId('ent_wz-sanyang_wetland-99');

    let threwForLocal = false;
    try {
      assertValidEntityId('local_ent_001');
    } catch {
      threwForLocal = true;
    }
    if (!threwForLocal) throw new Error('Failed to reject forbidden local_ prefix');

    let threwForUpper = false;
    try {
      assertValidEntityId('ENT_UPPERCASE_001');
    } catch {
      threwForUpper = true;
    }
    if (!threwForUpper) throw new Error('Failed to reject uppercase entity ID');
  });

  // 2. lookupEntity - EXACT_MATCH by canonical name
  await test('lookupEntity - EXACT_MATCH by canonical name', async () => {
    const adapter = new HubEntityAdapter();
    const resp = await adapter.lookupEntity({
      query_text: '温州市鹿城区人民政府',
      max_candidates: 5,
    });

    if (resp.resolution_status !== 'EXACT_MATCH') {
      throw new Error(`Expected EXACT_MATCH, got ${resp.resolution_status}`);
    }
    if (resp.selected_entity_id !== 'ent_wz_lucheng_gov_001') {
      throw new Error(`Expected ent_wz_lucheng_gov_001, got ${resp.selected_entity_id}`);
    }
    if (resp.matches.length < 1 || resp.matches[0].confidence < 0.85) {
      throw new Error('Expected top match confidence >= 0.85');
    }
  });

  // 3. lookupEntity - EXACT_MATCH by alias
  await test('lookupEntity - EXACT_MATCH by alias (五马街 -> 五马历史文化街区)', async () => {
    const adapter = new HubEntityAdapter();
    const resp = await adapter.lookupEntity({
      query_text: '五马街',
      max_candidates: 3,
    });

    if (resp.resolution_status !== 'EXACT_MATCH') {
      throw new Error(`Expected EXACT_MATCH, got ${resp.resolution_status}`);
    }
    if (resp.selected_entity_id !== 'ent_wz_wuma_street_002') {
      throw new Error(`Expected ent_wz_wuma_street_002, got ${resp.selected_entity_id}`);
    }
    if (resp.matches[0].canonical_name !== '五马历史文化街区') {
      throw new Error(`Expected canonical_name 五马历史文化街区, got ${resp.matches[0].canonical_name}`);
    }
  });

  // 4. lookupEntity - MULTIPLE_MATCHES (ambiguous entity)
  await test('lookupEntity - MULTIPLE_MATCHES on ambiguous query (温州人民医院)', async () => {
    const adapter = new HubEntityAdapter();
    const resp = await adapter.lookupEntity({
      query_text: '温州人民医院',
      max_candidates: 5,
    });

    if (resp.resolution_status !== 'MULTIPLE_MATCHES') {
      throw new Error(`Expected MULTIPLE_MATCHES, got ${resp.resolution_status}`);
    }
    if (resp.selected_entity_id !== undefined) {
      throw new Error(`Expected selected_entity_id to be undefined for ambiguous query`);
    }
    if (resp.matches.length < 2) {
      throw new Error('Expected at least 2 candidates for ambiguous query');
    }
  });

  // 5. lookupEntity - UNRESOLVED_NOT_FOUND
  await test('lookupEntity - UNRESOLVED_NOT_FOUND for unknown entity', async () => {
    const adapter = new HubEntityAdapter();
    const resp = await adapter.lookupEntity({
      query_text: '南塘未定名未来科技浮空塔2099',
      max_candidates: 5,
    });

    if (resp.resolution_status !== 'UNRESOLVED_NOT_FOUND') {
      throw new Error(`Expected UNRESOLVED_NOT_FOUND, got ${resp.resolution_status}`);
    }
    if (resp.selected_entity_id !== undefined) {
      throw new Error(`Expected undefined selected_entity_id`);
    }
    if (resp.matches.length !== 0) {
      throw new Error(`Expected 0 matches for completely unknown entity`);
    }
  });

  // 6. submitUnresolvedProposal - valid submission
  let submittedProposal: UnresolvedEntityProposal | null = null;
  await test('submitUnresolvedProposal - success with valid SHA-256 evidence hash', async () => {
    const adapter = new HubEntityAdapter();
    const evidence: ProposalSourceEvidence = {
      source_doc_id: 'doc_wz_daily_20261104_001',
      context_snippet: '据温州日报报道，温州城市未来创新中心今日在鹿城区正式揭牌成立。',
      evidence_span_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    };

    const prop = await adapter.submitUnresolvedProposal({
      candidate_name: '温州城市未来创新中心',
      source_evidence: evidence,
      suggested_aliases: ['未来创新中心', '温州创客大厦'],
      suggested_category: 'ORGANIZATION',
    });

    if (!prop.proposal_id.startsWith('prop_')) {
      throw new Error(`Invalid proposal_id: ${prop.proposal_id}`);
    }
    if (prop.proposal_status !== 'SUBMITTED') {
      throw new Error(`Expected status SUBMITTED, got ${prop.proposal_status}`);
    }
    if (prop.proposer_system !== 'WZCityTCDS') {
      throw new Error(`Expected proposer_system WZCityTCDS, got ${prop.proposer_system}`);
    }
    submittedProposal = prop;
  });

  // 7. submitUnresolvedProposal - reject invalid evidence hash
  await test('submitUnresolvedProposal - reject invalid evidence hash (non-SHA256)', async () => {
    const adapter = new HubEntityAdapter();
    let rejected = false;
    try {
      await adapter.submitUnresolvedProposal({
        candidate_name: '非法证据测试实体',
        source_evidence: {
          source_doc_id: 'doc_invalid_001',
          context_snippet: '测试非法证据哈希',
          evidence_span_hash: 'not-a-valid-sha256-hash',
        },
      });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('Failed to reject invalid evidence_span_hash');
  });

  // 8. applyAdjudication - ACCEPTED_ALLOCATED
  await test('applyAdjudication - ACCEPTED_ALLOCATED allocates standard entity_id', () => {
    if (!submittedProposal) throw new Error('Missing submittedProposal from previous test');
    const adapter = new HubEntityAdapter();
    const updated = adapter.applyAdjudication(
      submittedProposal,
      'ACCEPTED_ALLOCATED',
      {
        allocated_entity_id: 'ent_wz_future_center_001',
        canonical_name: '温州城市未来创新中心',
        resolution_notes: '经城市主数据专家评审通过，准予正式建档',
      }
    );

    if (updated.proposal_status !== 'ACCEPTED_ALLOCATED') {
      throw new Error(`Expected ACCEPTED_ALLOCATED, got ${updated.proposal_status}`);
    }
    if (updated.hub_adjudication?.allocated_entity_id !== 'ent_wz_future_center_001') {
      throw new Error(`Expected allocated_entity_id ent_wz_future_center_001`);
    }
  });

  // 9. applyAdjudication - MERGED_AS_ALIAS
  await test('applyAdjudication - MERGED_AS_ALIAS merges into existing entity', () => {
    if (!submittedProposal) throw new Error('Missing submittedProposal from previous test');
    const adapter = new HubEntityAdapter();
    const updated = adapter.applyAdjudication(
      submittedProposal,
      'MERGED_AS_ALIAS',
      {
        allocated_entity_id: 'ent_wz_sanyang_wetland_003',
        canonical_name: '三垟湿地公园',
        resolution_notes: '经核定该候选词为三垟湿地公园别名，合并处理',
      }
    );

    if (updated.proposal_status !== 'MERGED_AS_ALIAS') {
      throw new Error(`Expected MERGED_AS_ALIAS, got ${updated.proposal_status}`);
    }
    if (updated.hub_adjudication?.allocated_entity_id !== 'ent_wz_sanyang_wetland_003') {
      throw new Error(`Expected allocated_entity_id ent_wz_sanyang_wetland_003`);
    }
  });

  // 10. applyAdjudication - REJECTED
  await test('applyAdjudication - REJECTED rejects non-entity mention', () => {
    if (!submittedProposal) throw new Error('Missing submittedProposal from previous test');
    const adapter = new HubEntityAdapter();
    const updated = adapter.applyAdjudication(
      submittedProposal,
      'REJECTED',
      {
        resolution_notes: '经核定该词为临时活动标语，不构成城市空间/法人实体',
      }
    );

    if (updated.proposal_status !== 'REJECTED') {
      throw new Error(`Expected REJECTED, got ${updated.proposal_status}`);
    }
  });

  // 11. Caching behavior & bypass
  await test('caching behavior - cache hit and bypassCache option', async () => {
    let callCount = 0;
    const transport = new MockHubEntityTransport();
    const originalLookup = transport.lookup.bind(transport);
    transport.lookup = async (msg) => {
      callCount++;
      return originalLookup(msg);
    };

    const adapter = new HubEntityAdapter({ transport, enableCache: true });
    const req = { query_text: '温州市鹿城区人民政府', max_candidates: 5 };

    // Call 1: misses cache, calls transport
    await adapter.lookupEntity(req);
    if ((callCount as number) !== 1) throw new Error(`Expected callCount 1, got ${callCount}`);

    // Call 2: hits cache, transport not called
    await adapter.lookupEntity(req);
    if ((callCount as number) !== 1) throw new Error(`Expected callCount 1 (cache hit), got ${callCount}`);

    // Call 3: bypass cache, calls transport
    await adapter.lookupEntity(req, { bypassCache: true });
    if ((callCount as number) !== 2) throw new Error(`Expected callCount 2 (cache bypassed), got ${callCount}`);
  });

  // 12. MockHubEntityTransport custom entity registration
  await test('MockHubEntityTransport custom entity registration & resolution', async () => {
    const transport = new MockHubEntityTransport(false); // clean transport
    const customEnt: MatchedEntity = {
      entity_id: 'ent_wz_ouhai_park_007',
      canonical_name: '瓯海中央公园',
      aliases: ['瓯海绿地公园'],
      category: 'POI',
      confidence: 0.99,
      hub_uri: 'https://hub.wenzhou.gov.cn/entities/ent_wz_ouhai_park_007',
    };
    transport.registerEntity(customEnt);

    const adapter = new HubEntityAdapter({ transport });
    const resp = await adapter.lookupEntity({ query_text: '瓯海绿地公园', max_candidates: 5 });

    if (resp.resolution_status !== 'EXACT_MATCH') {
      throw new Error(`Expected EXACT_MATCH, got ${resp.resolution_status}`);
    }
    if (resp.selected_entity_id !== 'ent_wz_ouhai_park_007') {
      throw new Error(`Expected ent_wz_ouhai_park_007, got ${resp.selected_entity_id}`);
    }
  });

  // 13. Option A invariant: Rejects illegal allocated_entity_id in adjudication
  await test('Option A Invariant: Rejects illegal allocated_entity_id on ACCEPTED_ALLOCATED', () => {
    if (!submittedProposal) throw new Error('Missing submittedProposal');
    const adapter = new HubEntityAdapter();
    let rejected = false;
    try {
      adapter.applyAdjudication(
        submittedProposal,
        'ACCEPTED_ALLOCATED',
        {
          allocated_entity_id: 'local_pseudo_master_123', // illegal prefix!
          canonical_name: '非法本地实体',
        }
      );
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('Failed to reject non-Hub entity ID format');
  });

  return { passed, total, errors };
}

// Self-executing runner when executed via node
if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].includes('hub-entity.spec')) {
  runHubEntityAdapterTests().then((res) => {
    console.log(`\n=== FPF Slice C2 Hub Entity Adapter Test Suite Results ===`);
    console.log(`Total checks: ${res.total}`);
    console.log(`Passed:       ${res.passed}`);
    console.log(`Failed:       ${res.errors.length}`);
    if (res.errors.length > 0) {
      console.error(`\nErrors:\n` + res.errors.join('\n'));
      process.exit(1);
    } else {
      console.log(`\nALL ${res.total} HUB ENTITY ADAPTER CHECKS PASSED!\n`);
    }
  });
}
