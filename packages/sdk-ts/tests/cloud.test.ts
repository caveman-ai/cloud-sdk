import type {CloudOperations} from '../src/cloud.js';

type Assertion = CloudOperations['scenarios.create']['input']['assertions'][number];
const assertion: Assertion = {subject:'output',pointer:'/',operator:'equals',value:'expected'};
void assertion;
// @ts-expect-error Assertions require subject, pointer, operator and value.
const missing: Assertion = {};
// @ts-expect-error An arbitrary string cannot replace a typed assertion.
const invalid: Assertion = 'passed';
void missing; void invalid;

// audit.list pages with the server's keyset cursor and filters (GET /audit-logs).
const auditPage: CloudOperations['audit.list']['input'] = {cursor:'opaque', limit:50, action:'policy.publish', actor_id:'user-1', since:'2026-09-01T00:00:00Z', until:'2026-09-02T00:00:00Z'};
const auditNext: CloudOperations['audit.list']['output']['next_cursor'] = 'opaque';
void auditPage; void auditNext;

// prompts.get keeps the generated read by id and adds the cached resolve by slug.
import {Cloud, type ResolvedPrompt} from '../src/cloud.js';
import {Eval, type EvalResult} from '../src/evals.js';
declare const cloud: Cloud;
const byId: Promise<{data: CloudOperations['prompts.get']['output']}> = cloud.prompts.get({prompt_id: 'id'});
const bySlug: Promise<ResolvedPrompt> = cloud.prompts.get('support-reply', {environment: 'staging'});
// A Cloud client is what the local eval harness uploads through.
const evaluated: Promise<EvalResult> = Eval('support', {cloud, data: [{input: 'q'}], task: (input) => input, criteria: ['Grounded', ({output}) => output === 'a']});
void byId; void bySlug; void evaluated;
