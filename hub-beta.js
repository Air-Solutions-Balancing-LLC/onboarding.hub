// Isolated beta process — does not touch the live New Hire Checklist.
(function () {
  const STORAGE_KEY = 'beta_role_process';
  const DEFAULT_DEPARTMENTS = [
    {
      id: 'hr',
      label: 'HR',
      titles: [
        { id: 'vp_people_ops', label: 'VP of People Operations' },
        { id: 'recruiter', label: 'Recruiter' },
        { id: 'payroll_ap_hr', label: 'Payroll/Accounts Payable/HR' }
      ]
    },
    { id: 'admin', label: 'Admin', titles: [] },
    {
      id: 'logistics',
      label: 'Logistics',
      titles: [
        { id: 'logistics_manager', label: 'Logistics Manager' },
        { id: 'logistics_support', label: 'Logistics Support Specialist' },
        { id: 'it_manager', label: 'IT Manager' }
      ]
    },
    {
      id: 'training',
      label: 'Training',
      titles: [
        { id: 'training_coordinator', label: 'Training Coordinator' },
        { id: 'assistant_training_coordinator', label: 'Assistant Training Coordinator' }
      ]
    }
  ];
  const DEFAULT_DATA_FIELDS = [
    { id: 'email', label: 'Email address', input: 'email' },
    { id: 'phone', label: 'Phone number', input: 'phone' },
    { id: 'text', label: 'Text', input: 'text' },
    { id: 'date', label: 'Date', input: 'date' },
    { id: 'number', label: 'Number', input: 'number' }
  ];
  const INPUT_TYPES = [
    { id: 'text', label: 'Text' },
    { id: 'email', label: 'Email' },
    { id: 'phone', label: 'Phone' },
    { id: 'date', label: 'Date' },
    { id: 'number', label: 'Number' },
    { id: 'file', label: 'File (PDF or image)' }
  ];
  const GATE_RESULTS = [
    { id: 'complete', label: 'Complete' },
    { id: 'pass', label: 'Pass' },
    { id: 'fail', label: 'Fail' },
    { id: 'review', label: 'Review required' }
  ];

  let data = emptyData();
  let selectedDeptId = null;
  let selectedTitleId = null;
  let selectedStageId = null;
  let saveTimer = null;
  let addOutcome = 'confirm';
  let addRequired = true;
  let addFieldIds = [];
  let addDraftLabel = '';
  let addDraftNotes = '';
  let betaView = 'build';
  let mapTitleId = null;
  let mapStageId = null;
  let mapShowAllSteps = false;
  const mapOpenSteps = new Set();
  let mapScrollTop = 0;
  let catalogOpen = false;

  function cloneDepts() {
    return JSON.parse(JSON.stringify(DEFAULT_DEPARTMENTS));
  }

  function emptyData() {
    return {
      version: 3,
      departments: cloneDepts(),
      stepsByTitle: {},
      stagesByTitle: {},
      dataFields: DEFAULT_DATA_FIELDS.map((f) => Object.assign({}, f))
    };
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function slugFrom(label, used) {
    const base = String(label || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || 'item';
    let id = base;
    let n = 2;
    while (used.has(id)) {
      id = base + '_' + n;
      n += 1;
    }
    used.add(id);
    return id;
  }

  function allTitleIds(departments) {
    const ids = new Set();
    (departments || []).forEach((d) => (d.titles || []).forEach((t) => ids.add(t.id)));
    return ids;
  }

  function normalize(raw) {
    const base = emptyData();
    if (!raw || typeof raw !== 'object') return base;

    const usedDept = new Set();
    let departments;
    if (Array.isArray(raw.departments) && raw.departments.length) {
      departments = raw.departments.map((d) => {
        const label = String(d.label || d.id || 'Department').trim() || 'Department';
        const id = String(d.id || '').trim() || slugFrom(label, usedDept);
        usedDept.add(id);
        const usedTitle = new Set();
        const titles = Array.isArray(d.titles)
          ? d.titles.map((t) => {
              const tLabel = String(t.label || t.id || 'Job title').trim() || 'Job title';
              const tId = String(t.id || '').trim() || slugFrom(tLabel, usedTitle);
              usedTitle.add(tId);
              return { id: tId, label: tLabel };
            })
          : [];
        return { id, label, titles };
      });
    } else if (Array.isArray(raw.roles) && raw.roles.length) {
      departments = cloneDepts();
    } else {
      departments = base.departments;
    }

    const dataFields = normalizeDataFields(raw.dataFields);
    const stepsByTitle = {};
    const stagesByTitle = {};
    const incomingTitles = raw.stepsByTitle && typeof raw.stepsByTitle === 'object' ? raw.stepsByTitle : {};
    const incomingRoles = raw.stepsByRole && typeof raw.stepsByRole === 'object' ? raw.stepsByRole : {};
    const incomingStages = raw.stagesByTitle && typeof raw.stagesByTitle === 'object' ? raw.stagesByTitle : {};
    const knownTitles = allTitleIds(departments);

    knownTitles.forEach((id) => {
      const list = Array.isArray(incomingTitles[id]) ? incomingTitles[id] : [];
      stepsByTitle[id] = list.map((step, i) => normalizeStep(step, i, dataFields)).filter(Boolean);
      stagesByTitle[id] = normalizeStages(incomingStages[id], stepsByTitle[id], id);
    });

    // v1: steps lived on the department-as-role. Park them on the first job title if that title is still empty.
    departments.forEach((dept) => {
      const leftover = Array.isArray(incomingRoles[dept.id]) ? incomingRoles[dept.id] : [];
      if (!leftover.length || !dept.titles.length) return;
      const firstId = dept.titles[0].id;
      if (!stepsByTitle[firstId] || !stepsByTitle[firstId].length) {
        stepsByTitle[firstId] = leftover.map((step, i) => normalizeStep(step, i, dataFields)).filter(Boolean);
        stagesByTitle[firstId] = normalizeStages(incomingStages[firstId], stepsByTitle[firstId], firstId);
      }
    });

    return { version: 3, departments, stepsByTitle, stagesByTitle, dataFields };
  }

  function normalizeDataFields(list) {
    const used = new Set();
    const fields = (Array.isArray(list) && list.length ? list : DEFAULT_DATA_FIELDS).map((f) => {
      const label = String(f.label || f.id || 'Field').trim() || 'Field';
      const id = String(f.id || '').trim() || slugFrom(label, used);
      used.add(id);
      const input = INPUT_TYPES.some((t) => t.id === f.input) ? f.input : 'text';
      return { id, label, input };
    });
    return fields.length ? fields : DEFAULT_DATA_FIELDS.map((f) => Object.assign({}, f));
  }

  function normalizeWhen(when, ownerTitleId, localStageIds) {
    if (!when || when.type !== 'gate') return { type: 'always' };
    const result = GATE_RESULTS.some((r) => r.id === when.result) ? when.result : 'complete';
    const stageId = String(when.stageId || '');
    if (!stageId) return { type: 'always' };
    const titleId = String(when.titleId || ownerTitleId || '');
    if (!titleId) return { type: 'always' };
    if (titleId === ownerTitleId && localStageIds && !localStageIds.has(stageId)) {
      return { type: 'always' };
    }
    return { type: 'gate', titleId, stageId, result };
  }

  function normalizeStages(rawStages, steps, ownerTitleId) {
    const used = new Set();
    let stages = Array.isArray(rawStages) && rawStages.length
      ? rawStages.map((s, i) => {
          const label = String(s.label || s.id || 'Stage').trim() || 'Stage';
          const id = String(s.id || '').trim() || slugFrom(label, used);
          used.add(id);
          return {
            id,
            label,
            order: s.order != null ? s.order : i,
            when: {
              type: s.when && s.when.type === 'gate' ? 'gate' : 'always',
              titleId: s.when && s.when.titleId,
              stageId: s.when && s.when.stageId,
              result: s.when && s.when.result
            }
          };
        })
      : [];
    if (!stages.length) {
      const id = slugFrom('open_work', used);
      stages = [{ id, label: 'Open work', order: 0, when: { type: 'always' } }];
    }
    const ids = new Set(stages.map((s) => s.id));
    stages = stages.map((s) => ({
      id: s.id,
      label: s.label,
      order: s.order,
      when: normalizeWhen(s.when, ownerTitleId, ids)
    })).sort((a, b) => a.order - b.order);
    (steps || []).forEach((step) => {
      if (!ids.has(step.stageId)) step.stageId = stages[0].id;
    });
    return stages;
  }

  function workFields(item, order, fields, prefix) {
    if (!item) return null;
    const catalog = fields || data.dataFields || DEFAULT_DATA_FIELDS;
    const known = new Set(catalog.map((f) => f.id));
    let outputs = Array.isArray(item.outputs) ? item.outputs.map((id) => String(id)) : [];
    if (!outputs.length && item.dataKind) outputs = [String(item.dataKind)];
    outputs = [...new Set(outputs.filter((id) => known.has(id)))];
    let outcome = 'confirm';
    if (item.outcome === 'decision') outcome = 'decision';
    else if (item.outcome === 'data' || outputs.length) outcome = 'data';
    return {
      id: item.id || uid(prefix || 'bs'),
      label: String(item.label || '').trim() || 'Untitled step',
      notes: String(item.notes || '').trim(),
      outcome,
      outputs: outcome === 'data' ? outputs : [],
      required: item.required !== false,
      order: item.order != null ? item.order : order
    };
  }

  function normalizeSub(sub, order, fields) {
    const base = workFields(sub, order, fields, 'bss');
    if (!base) return null;
    if (base.outcome === 'decision') {
      base.outcome = 'confirm';
      base.outputs = [];
    }
    return base;
  }

  function normalizeStep(step, order, fields) {
    const base = workFields(step, order, fields, 'bs');
    if (!base) return null;
    const subs = Array.isArray(step.subs)
      ? step.subs.map((s, i) => normalizeSub(s, i, fields)).filter(Boolean)
      : [];
    return {
      id: base.id,
      label: base.label,
      notes: base.notes,
      outcome: base.outcome,
      outputs: base.outputs,
      required: base.required,
      stageId: String(step.stageId || ''),
      order: base.order,
      subs
    };
  }

  function subLetter(i) {
    return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
  }

  function findOwnedStep(stepId) {
    return stepsFor(selectedTitleId).find((s) => s.id === stepId) || null;
  }

  function findOwnedSub(parentId, subId) {
    const step = findOwnedStep(parentId);
    if (!step) return null;
    if (!Array.isArray(step.subs)) step.subs = [];
    return step.subs.find((s) => s.id === subId) || null;
  }

  function incomingNeedsRequiredSeed(raw) {
    function missing(item) {
      if (!item || typeof item !== 'object') return false;
      if (typeof item.required !== 'boolean') return true;
      return Array.isArray(item.subs) && item.subs.some(missing);
    }
    function lists(obj) {
      if (!obj || typeof obj !== 'object') return [];
      return Object.keys(obj).map((k) => obj[k]);
    }
    return lists(raw && raw.stepsByTitle).concat(lists(raw && raw.stepsByRole)).some((list) =>
      Array.isArray(list) && list.some(missing)
    );
  }

  function isRequired(item) {
    return !item || item.required !== false;
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (window.HubAuth && HubAuth.save) {
        HubAuth.save(STORAGE_KEY, {
          version: 3,
          departments: data.departments,
          stepsByTitle: data.stepsByTitle,
          stagesByTitle: data.stagesByTitle,
          dataFields: data.dataFields
        });
      }
      if (window.HubChecklist && HubChecklist.refreshFromProcess) {
        HubChecklist.refreshFromProcess();
      }
    }, 250);
  }

  function stepsFor(titleId) {
    if (!titleId) return [];
    if (!Array.isArray(data.stepsByTitle[titleId])) data.stepsByTitle[titleId] = [];
    return data.stepsByTitle[titleId];
  }

  function stagesFor(titleId) {
    if (!titleId) return [];
    if (!data.stagesByTitle) data.stagesByTitle = {};
    const steps = stepsFor(titleId);
    data.stagesByTitle[titleId] = normalizeStages(data.stagesByTitle[titleId], steps, titleId);
    return data.stagesByTitle[titleId];
  }

  function stepsInStage(titleId, stageId) {
    return stepsFor(titleId).filter((s) => s.stageId === stageId);
  }

  function stageHasDecision(titleId, stageId) {
    return stepsInStage(titleId, stageId).some((s) => s.outcome === 'decision');
  }

  function waitValue(titleId, stageId) {
    return `${titleId}::${stageId}`;
  }

  function parseWaitValue(val) {
    if (!val || val === 'always') return null;
    const i = String(val).indexOf('::');
    if (i < 0) return { titleId: selectedTitleId, stageId: String(val) };
    return { titleId: val.slice(0, i), stageId: val.slice(i + 2) };
  }

  function titleMeta(titleId) {
    for (let d = 0; d < (data.departments || []).length; d += 1) {
      const dept = data.departments[d];
      const title = (dept.titles || []).find((t) => t.id === titleId);
      if (title) return { dept, title };
    }
    return null;
  }

  function waitTargets(exceptTitleId, exceptStageId) {
    const out = [];
    (data.departments || []).forEach((dept) => {
      (dept.titles || []).forEach((title) => {
        stagesFor(title.id).forEach((stage) => {
          if (title.id === exceptTitleId && stage.id === exceptStageId) return;
          out.push({
            titleId: title.id,
            stageId: stage.id,
            deptLabel: dept.label,
            titleLabel: title.label,
            stageLabel: stage.label,
            group: `${dept.label} · ${title.label}`,
            key: waitValue(title.id, stage.id),
            hasDecision: stageHasDecision(title.id, stage.id)
          });
        });
      });
    });
    return out;
  }

  function groupedStageOptionsHtml(targets, selectedKey, opts) {
    const withTitle = !!(opts && opts.withTitle);
    const groups = [];
    targets.forEach((t) => {
      let g = groups.find((x) => x.name === t.group);
      if (!g) {
        g = { name: t.group, opts: [] };
        groups.push(g);
      }
      g.opts.push(t);
    });
    return groups.map((g) =>
      `<optgroup label="${esc(g.name)}">${g.opts.map((t) => {
        const label = withTitle ? `${t.titleLabel} · ${t.stageLabel}` : t.stageLabel;
        return `<option value="${esc(t.key)}" ${t.key === selectedKey ? 'selected' : ''}>${esc(label)}</option>`;
      }).join('')}</optgroup>`
    ).join('');
  }

  function waitOptionsHtml(targets, selectedKey, placeholder) {
    const always = `<option value="always" ${selectedKey ? '' : 'selected'}>${esc(placeholder || 'No wait — can start anytime')}</option>`;
    return always + groupedStageOptionsHtml(targets, selectedKey);
  }

  function gateTargetLabel(when, ownerTitleId) {
    if (!when || when.type !== 'gate') return 'another stage';
    const meta = titleMeta(when.titleId);
    const stage = ((data.stagesByTitle || {})[when.titleId] || []).find((s) => s.id === when.stageId);
    const stageName = stage ? stage.label : 'a stage';
    const owner = ownerTitleId || selectedTitleId;
    if (!meta || when.titleId === owner) return stageName;
    return `${meta.title.label} · ${stageName}`;
  }

  function clearGatesTo(titleId, stageId) {
    Object.keys(data.stagesByTitle || {}).forEach((tid) => {
      (data.stagesByTitle[tid] || []).forEach((st) => {
        if (!st.when || st.when.type !== 'gate') return;
        const srcTitle = st.when.titleId || tid;
        const matchTitle = srcTitle === titleId;
        const matchStage = !stageId || st.when.stageId === stageId;
        if (matchTitle && matchStage) st.when = { type: 'always' };
      });
    });
  }

  function titlesWithStages() {
    const rows = [];
    (data.departments || []).forEach((dept) => {
      (dept.titles || []).forEach((title) => {
        rows.push({ dept, title, stages: stagesFor(title.id) });
      });
    });
    return rows;
  }

  function collectGateEdges() {
    const edges = [];
    titlesWithStages().forEach(({ title, stages }) => {
      stages.forEach((stage) => {
        if (!stage.when || stage.when.type !== 'gate') return;
        edges.push({
          fromTitle: stage.when.titleId,
          fromStage: stage.when.stageId,
          toTitle: title.id,
          toStage: stage.id,
          result: stage.when.result || 'complete'
        });
      });
    });
    return edges;
  }

  function viewToggleHtml() {
    return `
      <div class="beta-views" role="tablist" aria-label="Beta views">
        <button type="button" class="beta-view ${betaView === 'build' ? 'is-on' : ''}" data-beta-view="build">Process</button>
        <button type="button" class="beta-view ${betaView === 'gates' ? 'is-on' : ''}" data-beta-view="gates">Flow</button>
      </div>
    `;
  }

  function flowNodeKey(titleId, stageId) {
    return waitValue(titleId, stageId);
  }

  function flowStepsOpen(key) {
    return mapShowAllSteps || mapOpenSteps.has(key);
  }

  function outcomeShort(item) {
    if (item && item.outcome === 'data') return 'Produces data';
    if (item && item.outcome === 'decision') return 'Decision';
    return 'Confirmation';
  }

  function flowNodes() {
    const nodes = [];
    titlesWithStages().forEach(({ dept, title, stages }) => {
      stages.forEach((stage, i) => {
        nodes.push({
          key: flowNodeKey(title.id, stage.id),
          titleId: title.id,
          stageId: stage.id,
          dept,
          title,
          stage,
          orderInTitle: i
        });
      });
    });
    return nodes;
  }

  function orderedFlowNodes() {
    const nodes = flowNodes();
    const byKey = new Map(nodes.map((n) => [n.key, n]));
    const incoming = new Map(nodes.map((n) => [n.key, 0]));
    const outgoing = new Map(nodes.map((n) => [n.key, []]));
    collectGateEdges().forEach((e) => {
      const from = flowNodeKey(e.fromTitle, e.fromStage);
      const to = flowNodeKey(e.toTitle, e.toStage);
      if (!byKey.has(from) || !byKey.has(to) || from === to) return;
      outgoing.get(from).push(to);
      incoming.set(to, incoming.get(to) + 1);
    });
    const queue = nodes.filter((n) => incoming.get(n.key) === 0).map((n) => n.key);
    const seen = new Set();
    const out = [];
    while (queue.length) {
      const k = queue.shift();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(byKey.get(k));
      (outgoing.get(k) || []).forEach((next) => {
        incoming.set(next, incoming.get(next) - 1);
        if (incoming.get(next) === 0) queue.push(next);
      });
    }
    nodes.forEach((n) => {
      if (!seen.has(n.key)) out.push(n);
    });
    return out;
  }

  function flowStepPreviewHtml(step, idx) {
    const subs = step.subs || [];
    return `
      <li class="beta-flow-step ${isRequired(step) ? '' : 'is-optional'}">
        <span class="beta-flow-step-n">${idx + 1}</span>
        <div>
          <strong>${esc(step.label)}</strong>
          <span>${isRequired(step) ? 'Required' : 'Optional'} · ${esc(outcomeShort(step))}${subs.length ? ` · ${subs.length} sub-step${subs.length === 1 ? '' : 's'}` : ''}</span>
          ${subs.length ? `<ol class="beta-flow-subs">${subs.map((sub, j) =>
            `<li>${esc(subLetter(j))}. ${esc(sub.label)}${isRequired(sub) ? '' : ' · optional'}</li>`
          ).join('')}</ol>` : ''}
        </div>
      </li>
    `;
  }

  function flowConnectorHtml(node) {
    const when = node.stage.when;
    if (!when || when.type !== 'gate') {
      return `<div class="beta-flow-join" aria-hidden="true"><span class="beta-flow-join-line"></span></div>`;
    }
    const kind = when.result === 'fail' ? 'is-fail' : (when.result === 'pass' ? 'is-pass' : '');
    return `
      <div class="beta-flow-join ${kind}">
        <span class="beta-flow-join-line"></span>
        <span class="beta-flow-join-label">Waits on ${esc(gateTargetLabel(when, node.titleId))} · ${esc(gateResultLabel(when.result || 'complete'))}</span>
        <span class="beta-flow-join-line"></span>
      </div>
    `;
  }

  function gateMapHtml() {
    const nodes = orderedFlowNodes();
    if (!nodes.length) {
      return `<div class="beta-empty">Add stages in Process. They will show up here as a top-to-bottom flow.</div>`;
    }
    const stillThere = nodes.some((n) => n.titleId === mapTitleId && n.stageId === mapStageId);
    if (!stillThere) {
      const firstGate = nodes.find((n) => n.stage.when && n.stage.when.type === 'gate');
      mapTitleId = (firstGate || nodes[0]).titleId;
      mapStageId = (firstGate || nodes[0]).stageId;
    }
    const selStage = mapTitleId ? stagesFor(mapTitleId).find((s) => s.id === mapStageId) : null;
    const selMeta = mapTitleId ? titleMeta(mapTitleId) : null;
    const anyOpen = nodes.some((n) => flowStepsOpen(n.key));
    const cards = nodes.map((node, i) => {
      const stageSteps = stepsInStage(node.titleId, node.stageId);
      const n = stageSteps.length;
      const subN = stageSteps.reduce((sum, s) => sum + ((s.subs || []).length), 0);
      const gated = node.stage.when && node.stage.when.type === 'gate';
      const on = node.titleId === mapTitleId && node.stageId === mapStageId;
      const open = flowStepsOpen(node.key);
      const stepWord = n === 1 ? 'step' : 'steps';
      return `
        ${i ? flowConnectorHtml(node) : ''}
        <article class="beta-flow-card ${on ? 'is-on' : ''} ${gated ? 'is-gated' : ''}" data-flow-card="${esc(node.key)}">
          <button type="button" class="beta-flow-head" data-gate-title="${esc(node.titleId)}" data-gate-stage="${esc(node.stageId)}">
            <span class="beta-flow-idx">${String(i + 1).padStart(2, '0')}</span>
            <span class="beta-flow-head-copy">
              <span class="beta-kicker">${esc(node.dept.label)} · ${esc(node.title.label)}</span>
              <strong>${esc(node.stage.label)}</strong>
              <span class="beta-flow-meta">${n} ${stepWord}${subN ? ` · ${subN} sub` : ''}${gated ? '' : ' · can start anytime'}</span>
            </span>
          </button>
          <button type="button" class="beta-flow-toggle" data-flow-steps="${esc(node.key)}" aria-expanded="${open ? 'true' : 'false'}" ${n ? '' : 'disabled'}>
            ${open ? 'Hide steps' : (n ? `Show ${n} ${stepWord}` : 'No steps yet')}
          </button>
          ${open ? `
            <div class="beta-flow-body">
              ${n
                ? `<ol class="beta-flow-steps">${stageSteps.map((step, si) => flowStepPreviewHtml(step, si)).join('')}</ol>`
                : '<p class="beta-bench-sub">No steps in this stage yet.</p>'}
            </div>
          ` : ''}
        </article>
      `;
    }).join('');
    return `
      <div class="beta-map-shell">
        <div class="beta-flow-toolbar">
          <p class="beta-bench-sub">Read top to bottom — later work sits under the stage it waits on. Click a stage to change the gate. Use Show steps to peek at the work inside.</p>
          <div class="beta-flow-toolbar-actions">
            <button type="button" class="btn-secondary" data-flow-all="on" ${mapShowAllSteps ? 'disabled' : ''}>Show all steps</button>
            <button type="button" class="btn-secondary" data-flow-all="off" ${anyOpen ? '' : 'disabled'}>Hide all steps</button>
            <button type="button" class="btn-secondary" data-flow-export="pdf">Export PDF</button>
            <button type="button" class="btn-secondary" data-flow-export="xlsx">Export Excel</button>
          </div>
        </div>
        <div class="beta-map-layout">
          <div class="beta-flow-canvas" id="beta-flow-canvas">
            <div class="beta-flow-list">${cards}</div>
          </div>
          <aside class="beta-map-inspect" aria-label="Edit selected stage gate">
            ${selStage && selMeta ? `
              <div class="beta-kicker">${esc(selMeta.dept.label)} · ${esc(selMeta.title.label)}</div>
              <h3 class="beta-map-lane-title">${esc(selStage.label)}</h3>
              <p class="beta-bench-sub">${esc(whenSummary(selStage.when, mapTitleId))}</p>
              ${stageWhenControls(selStage, stagesFor(mapTitleId), mapTitleId)}
              <button type="button" class="btn-secondary" data-beta-open-process="${esc(mapTitleId)}">Edit steps in Process</button>
            ` : '<p class="beta-empty">Select a stage.</p>'}
          </aside>
        </div>
      </div>
    `;
  }

  function flowWaitLabel(node) {
    const when = node.stage && node.stage.when;
    if (!when || when.type !== 'gate') return 'Can start anytime';
    return `Waits on ${gateTargetLabel(when, node.titleId)} · ${gateResultLabel(when.result || 'complete')}`;
  }

  function outputFieldLabels(ids) {
    const catalog = data.dataFields || [];
    return (ids || []).map((id) => {
      const f = catalog.find((x) => x.id === id);
      return f ? f.label : id;
    }).filter(Boolean).join('; ');
  }

  function exportStamp() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function sheetCols(rows) {
    const keys = Object.keys(rows[0] || {});
    return keys.map((k) => {
      let w = k.length;
      rows.forEach((r) => {
        const n = String(r[k] == null ? '' : r[k]).length;
        if (n > w) w = n;
      });
      return { wch: Math.min(48, Math.max(10, w + 1)) };
    });
  }

  function flowExportRows() {
    const nodes = orderedFlowNodes();
    const stages = [];
    const steps = [];
    nodes.forEach((node, i) => {
      const wait = flowWaitLabel(node);
      const stageSteps = stepsInStage(node.titleId, node.stageId);
      const subN = stageSteps.reduce((sum, s) => sum + ((s.subs || []).length), 0);
      stages.push({
        '#': i + 1,
        Department: node.dept.label,
        'Job title': node.title.label,
        Stage: node.stage.label,
        Wait: wait,
        Steps: stageSteps.length,
        'Sub-steps': subN
      });
      if (!stageSteps.length) {
        steps.push({
          'Flow #': i + 1,
          Department: node.dept.label,
          'Job title': node.title.label,
          Stage: node.stage.label,
          Wait: wait,
          'Step #': '',
          'Sub-step': '',
          Work: '(no steps yet)',
          Need: '',
          Type: '',
          Notes: '',
          'Data produced': ''
        });
        return;
      }
      stageSteps.forEach((step, si) => {
        steps.push({
          'Flow #': i + 1,
          Department: node.dept.label,
          'Job title': node.title.label,
          Stage: node.stage.label,
          Wait: wait,
          'Step #': si + 1,
          'Sub-step': '',
          Work: step.label,
          Need: isRequired(step) ? 'Required' : 'Optional',
          Type: outcomeShort(step),
          Notes: step.notes || '',
          'Data produced': outputFieldLabels(step.outputs)
        });
        (step.subs || []).forEach((sub, j) => {
          steps.push({
            'Flow #': i + 1,
            Department: node.dept.label,
            'Job title': node.title.label,
            Stage: node.stage.label,
            Wait: wait,
            'Step #': si + 1,
            'Sub-step': subLetter(j),
            Work: sub.label,
            Need: isRequired(sub) ? 'Required' : 'Optional',
            Type: outcomeShort(sub),
            Notes: sub.notes || '',
            'Data produced': outputFieldLabels(sub.outputs)
          });
        });
      });
    });
    return { nodes, stages, steps };
  }

  function exportFlowExcel() {
    if (!window.XLSX || !XLSX.utils) {
      alert('Excel export is not available. Refresh the page and try again.');
      return;
    }
    const { stages, steps } = flowExportRows();
    if (!stages.length) {
      alert('Add stages in Process first.');
      return;
    }
    const wb = XLSX.utils.book_new();
    const stageSheet = XLSX.utils.json_to_sheet(stages);
    const stepSheet = XLSX.utils.json_to_sheet(steps);
    stageSheet['!cols'] = sheetCols(stages);
    stepSheet['!cols'] = sheetCols(steps);
    XLSX.utils.book_append_sheet(wb, stageSheet, 'Flow');
    XLSX.utils.book_append_sheet(wb, stepSheet, 'Steps');
    XLSX.writeFile(wb, `onboarding-flow-${exportStamp()}.xlsx`);
  }

  function flowPdfStepHtml(step, idx) {
    const subs = step.subs || [];
    const dataLine = outputFieldLabels(step.outputs);
    return `
      <li class="pf-step">
        <span class="pf-step-n">${idx + 1}</span>
        <div>
          <strong>${esc(step.label)}</strong>
          <p>${isRequired(step) ? 'Required' : 'Optional'} · ${esc(outcomeShort(step))}${dataLine ? ` · ${esc(dataLine)}` : ''}</p>
          ${step.notes ? `<p class="pf-notes">${esc(step.notes)}</p>` : ''}
          ${subs.length ? `<ol class="pf-subs">${subs.map((sub, j) =>
            `<li><strong>${esc(subLetter(j))}. ${esc(sub.label)}</strong>
              <span> · ${isRequired(sub) ? 'Required' : 'Optional'} · ${esc(outcomeShort(sub))}</span>
              ${sub.notes ? `<p class="pf-notes">${esc(sub.notes)}</p>` : ''}</li>`
          ).join('')}</ol>` : ''}
        </div>
      </li>
    `;
  }

  function flowPdfHtml() {
    const { nodes } = flowExportRows();
    const sections = nodes.map((node, i) => {
      const stageSteps = stepsInStage(node.titleId, node.stageId);
      return `
        <section class="pf-stage">
          <header>
            <span class="pf-idx">${String(i + 1).padStart(2, '0')}</span>
            <div>
              <p class="pf-kicker">${esc(node.dept.label)} · ${esc(node.title.label)}</p>
              <h2>${esc(node.stage.label)}</h2>
              <p class="pf-wait">${esc(flowWaitLabel(node))}</p>
            </div>
          </header>
          ${stageSteps.length
            ? `<ol class="pf-steps">${stageSteps.map((step, si) => flowPdfStepHtml(step, si)).join('')}</ol>`
            : '<p class="pf-empty">No steps in this stage yet.</p>'}
        </section>
      `;
    }).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Onboarding flow ${esc(exportStamp())}</title>
  <style>
    @page { size: letter; margin: .6in; }
    * { box-sizing: border-box; }
    body {
      margin: 0; color: #0c1a33;
      font: 12px/1.45 Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .pf-lede { color: #3d4a5c; margin: 0 0 18px; }
    .pf-stage { border: 1px solid #0c1a33; padding: 12px 14px; margin: 0 0 14px; break-inside: avoid; }
    .pf-stage header { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 10px; margin-bottom: 10px; }
    .pf-idx { font-weight: 800; font-size: 20px; letter-spacing: .04em; }
    .pf-kicker { margin: 0; font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: #5b6b7c; }
    h2 { margin: 2px 0 4px; font-size: 16px; }
    .pf-wait { margin: 0; color: #3d4a5c; }
    .pf-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .pf-step { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; break-inside: avoid; }
    .pf-step-n { font-weight: 800; color: #5b6b7c; }
    .pf-step p { margin: 2px 0 0; color: #3d4a5c; }
    .pf-notes { white-space: pre-wrap; }
    .pf-subs { margin: 6px 0 0; padding: 0 0 0 16px; }
    .pf-empty { margin: 0; color: #5b6b7c; }
  </style>
</head>
<body>
  <h1>Onboarding flow</h1>
  <p class="pf-lede">Beta process as of ${esc(exportStamp())}. Later work sits under the stage it waits on. The live New Hire Checklist is unchanged.</p>
  ${sections || '<p>No stages yet.</p>'}
</body>
</html>`;
  }

  function exportFlowPdf() {
    const nodes = orderedFlowNodes();
    if (!nodes.length) {
      alert('Add stages in Process first.');
      return;
    }
    const html = flowPdfHtml();
    const w = window.open('', '_blank');
    if (w) {
      w.document.open();
      w.document.write(html);
      w.document.close();
      w.focus();
      setTimeout(() => {
        w.print();
      }, 250);
      return;
    }
    const iframe = document.createElement('iframe');
    iframe.className = 'beta-print-frame';
    iframe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    doc.open();
    doc.write(html);
    doc.close();
    const cleanup = () => iframe.remove();
    iframe.contentWindow.onafterprint = cleanup;
    setTimeout(() => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      setTimeout(cleanup, 4000);
    }, 250);
  }

  function gateResultLabel(id) {
    return (GATE_RESULTS.find((r) => r.id === id) || {}).label || id;
  }

  function whenSummary(when, ownerTitleId) {
    if (!when || when.type !== 'gate') return 'No wait — this work can start anytime.';
    const name = gateTargetLabel(when, ownerTitleId);
    if (!when.result || when.result === 'complete') {
      return `Waits until ${name} is complete. Later work does not start until every required step in that stage is done. Optional steps can be skipped.`;
    }
    return `Waits until ${name} is complete and the decision is ${gateResultLabel(when.result)}. Review required keeps this closed until that decision changes.`;
  }

  function selectedDept() {
    return (data.departments || []).find((d) => d.id === selectedDeptId) || null;
  }

  function selectedTitle() {
    const dept = selectedDept();
    if (!dept) return null;
    return (dept.titles || []).find((t) => t.id === selectedTitleId) || null;
  }

  function titleCount(dept) {
    return (dept.titles || []).reduce((n, t) => n + stepsFor(t.id).length, 0);
  }

  function inputTypeLabel(id) {
    return (INPUT_TYPES.find((t) => t.id === id) || {}).label || 'Text';
  }

  function inputTypeOptions(selected) {
    return INPUT_TYPES.map((t) =>
      `<option value="${esc(t.id)}" ${t.id === selected ? 'selected' : ''}>${esc(t.label)}</option>`
    ).join('');
  }

  function fieldChecksHtml(selectedIds, opts) {
    const picked = new Set(selectedIds || []);
    const fields = data.dataFields || [];
    if (!fields.length) return '<p class="beta-bench-sub">Add a data field in What data first.</p>';
    const add = !!(opts && opts.add);
    const stepId = opts && opts.stepId;
    return `<div class="beta-field-picks">${fields.map((f) => `
      <label class="beta-field-check ${picked.has(f.id) ? 'is-on' : ''}">
        <input type="checkbox" ${add
          ? `data-add-field="${esc(f.id)}"`
          : (opts && opts.parentId
            ? `data-sub-output="${esc(opts.parentId)}" data-sub-id="${esc(stepId)}" value="${esc(f.id)}"`
            : `data-step-output="${esc(stepId)}" value="${esc(f.id)}"`)}
          ${picked.has(f.id) ? 'checked' : ''}>
        ${esc(f.label)}
        <span class="beta-field-kind">${esc(inputTypeLabel(f.input))}</span>
      </label>
    `).join('')}</div>`;
  }

  function catalogHtml() {
    const fields = data.dataFields || [];
    const n = fields.length;
    const rows = fields.map((f) => `
      <tr>
        <td><input class="form-input" data-df-label="${esc(f.id)}" value="${esc(f.label)}" /></td>
        <td><select class="form-input" data-df-input="${esc(f.id)}">${inputTypeOptions(f.input)}</select></td>
        <td><button type="button" class="btn-xs danger" data-df-del="${esc(f.id)}">Remove</button></td>
      </tr>
    `).join('');
    const toggleLabel = catalogOpen
      ? 'Hide field list'
      : (n ? `Show ${n} field${n === 1 ? '' : 's'}` : 'Show field list');
    return `
      <section class="beta-catalog" aria-label="What data">
        <div class="beta-catalog-head">
          <div>
            <div class="beta-kicker">What data</div>
            <p class="beta-bench-sub">This is the shared list of data a step can produce. Use File (PDF or image) for things like a diploma or OSHA card. A step can check more than one.</p>
          </div>
          <button type="button" class="btn-secondary" id="beta-catalog-toggle" aria-expanded="${catalogOpen ? 'true' : 'false'}">${esc(toggleLabel)}</button>
        </div>
        <div class="beta-add-role beta-catalog-add">
          <input class="form-input" id="beta-new-field" type="text" placeholder="e.g. HS diploma" />
          <select class="form-input" id="beta-new-field-input">${inputTypeOptions('text')}</select>
          <button type="button" class="btn-secondary" id="beta-add-field">Add data field</button>
        </div>
        ${catalogOpen ? `
        <div class="nh-table-wrap">
          <table class="data-table">
            <thead><tr><th>Field name</th><th>Input</th><th></th></tr></thead>
            <tbody>${rows || '<tr><td colspan="3" class="nh-empty">No data fields yet.</td></tr>'}</tbody>
          </table>
        </div>` : ''}
      </section>`;
  }

  function ensureSelection() {
    if (!selectedDeptId || !data.departments.some((d) => d.id === selectedDeptId)) {
      selectedDeptId = data.departments[0] ? data.departments[0].id : null;
    }
    const dept = selectedDept();
    const titles = dept ? dept.titles || [] : [];
    if (!selectedTitleId || !titles.some((t) => t.id === selectedTitleId)) {
      selectedTitleId = titles[0] ? titles[0].id : null;
    }
    if (selectedTitleId) {
      const stages = stagesFor(selectedTitleId);
      if (!selectedStageId || !stages.some((s) => s.id === selectedStageId)) {
        selectedStageId = stages[0] ? stages[0].id : null;
      }
    } else {
      selectedStageId = null;
    }
  }

  function outcomeValue(step) {
    if (!step) return 'confirm';
    if (step.outcome === 'decision' || step.outcome === 'data') return step.outcome;
    return 'confirm';
  }

  function setOutcome(value) {
    if (value === 'data' || value === 'decision') return value;
    return 'confirm';
  }

  function stepOutcomeRadios(step, opts) {
    const cur = outcomeValue(step);
    const parent = opts && opts.parentId;
    const allowDecision = !(opts && opts.noDecision);
    const name = parent ? `out-${parent}-${step.id}` : `out-${step.id}`;
    const bind = parent
      ? `data-sub-outcome="${esc(step.id)}" data-parent="${esc(parent)}"`
      : `data-step-outcome="${esc(step.id)}"`;
    const shown = (cur === 'decision' && !allowDecision) ? 'confirm' : cur;
    return `
      <div class="beta-step-result">
        <label class="beta-toggle">
          <input type="radio" name="${esc(name)}" ${bind} value="confirm" ${shown === 'confirm' ? 'checked' : ''}>
          Confirmation only
        </label>
        <label class="beta-toggle">
          <input type="radio" name="${esc(name)}" ${bind} value="data" ${shown === 'data' ? 'checked' : ''}>
          Produces data
        </label>
        ${allowDecision ? `
        <label class="beta-toggle">
          <input type="radio" name="${esc(name)}" ${bind} value="decision" ${shown === 'decision' ? 'checked' : ''}>
          Decision
        </label>` : ''}
      </div>
      ${shown === 'decision' ? '<p class="beta-gate-note">Pass continues. Fail goes to the Fail stage (rescind). Review required holds later stages until someone decides.</p>' : ''}
    `;
  }

  function requiredNeedRadios(item, opts) {
    const required = isRequired(item);
    const parent = opts && opts.parentId;
    const name = parent ? `need-${parent}-${item.id}` : `need-${item.id}`;
    const bind = parent
      ? `data-sub-required="${esc(item.id)}" data-parent="${esc(parent)}"`
      : `data-step-required="${esc(item.id)}"`;
    return `
      <div class="beta-step-need" role="radiogroup" aria-label="Required or optional">
        <span class="form-label">This work is</span>
        <label class="beta-toggle">
          <input type="radio" name="${esc(name)}" ${bind} value="1" ${required ? 'checked' : ''}>
          Required
        </label>
        <label class="beta-toggle">
          <input type="radio" name="${esc(name)}" ${bind} value="0" ${required ? '' : 'checked'}>
          Optional
        </label>
      </div>
    `;
  }

  function stageWhenControls(stage, stages, titleId) {
    const isGate = stage.when && stage.when.type === 'gate';
    const srcTitle = isGate ? (stage.when.titleId || titleId) : '';
    const srcId = isGate ? stage.when.stageId : '';
    const selectedKey = isGate ? waitValue(srcTitle, srcId) : '';
    const result = isGate ? (stage.when.result || 'complete') : 'complete';
    const srcHasDecision = !!(srcTitle && srcId && stageHasDecision(srcTitle, srcId));
    const targets = waitTargets(titleId, stage.id);
    return `
      <div class="beta-stage-when">
        <label class="form-label">Waits until this stage is complete</label>
        <select class="form-input" data-stage-wait="${esc(stage.id)}" data-wait-title="${esc(titleId)}">
          ${waitOptionsHtml(targets, selectedKey)}
        </select>
        ${srcHasDecision ? `
          <label class="form-label">And that stage’s decision must be</label>
          <select class="form-input" data-stage-wait-result="${esc(stage.id)}" data-wait-title="${esc(titleId)}">
            ${GATE_RESULTS.map((r) =>
              `<option value="${esc(r.id)}" ${result === r.id ? 'selected' : ''}>${esc(r.label)}</option>`
            ).join('')}
          </select>
        ` : (isGate ? '<p class="beta-bench-sub">Closed until every required step in the selected stage is done — including stages owned by another job title. Optional steps can be skipped.</p>' : '')}
      </div>
    `;
  }

  function subRowHtml(step, sub, parentIdx, idx, subs) {
    return `
      <li class="beta-sub ${isRequired(sub) ? '' : 'is-optional'}" data-sub-id="${esc(sub.id)}">
        <div class="beta-step-index">${parentIdx + 1}.${subLetter(idx)}</div>
        <div class="beta-step-body">
          <label class="beta-stage-name-wrap">
            <span class="form-label">Sub-step name</span>
            <input class="form-input beta-step-name" data-sub-label="${esc(sub.id)}" data-parent="${esc(step.id)}" value="${esc(sub.label)}" placeholder="e.g. Install software" />
          </label>
          ${requiredNeedRadios(sub, { parentId: step.id })}
          ${stepOutcomeRadios(sub, { parentId: step.id, noDecision: true })}
          ${sub.outcome === 'data' ? `<div class="beta-step-fields">${fieldChecksHtml(sub.outputs || [], { stepId: sub.id, parentId: step.id })}</div>` : ''}
          <label class="beta-step-notes">
            <span class="form-label">Notes for the person doing this</span>
            <textarea class="form-input beta-step-notes-input" data-sub-notes="${esc(sub.id)}" data-parent="${esc(step.id)}" rows="2" placeholder="Context, how to do it, or anything they should know">${esc(sub.notes || '')}</textarea>
          </label>
        </div>
        <div class="beta-step-actions">
          <button type="button" class="btn-xs" data-sub-up="${esc(sub.id)}" data-parent="${esc(step.id)}" ${idx === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button type="button" class="btn-xs" data-sub-down="${esc(sub.id)}" data-parent="${esc(step.id)}" ${idx === subs.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button type="button" class="btn-xs danger" data-sub-del="${esc(sub.id)}" data-parent="${esc(step.id)}">Remove</button>
        </div>
      </li>
    `;
  }

  function subsBlockHtml(step, parentIdx) {
    const subs = step.subs || [];
    const requiredNames = subs.map((s, i) => (isRequired(s) ? `${parentIdx + 1}.${subLetter(i)}` : null)).filter(Boolean);
    let note;
    if (!subs.length) {
      note = `<p class="beta-bench-sub">Add ${parentIdx + 1}.A, ${parentIdx + 1}.B if this work has parts. Required sub-steps must be done before the parent can complete. Optional ones can be skipped.</p>`;
    } else if (requiredNames.length) {
      note = `<p class="beta-gate-note">Step ${parentIdx + 1} cannot be complete until required sub-step${requiredNames.length === 1 ? '' : 's'} ${requiredNames.join(', ')} ${requiredNames.length === 1 ? 'is' : 'are'} done. Optional sub-steps can be skipped.</p>`;
    } else {
      note = `<p class="beta-bench-sub">All sub-steps are optional. They can be skipped without blocking step ${parentIdx + 1}.</p>`;
    }
    return `
      <div class="beta-subs">
        <div class="beta-kicker">Sub-steps</div>
        ${note}
        ${subs.length ? `<ol class="beta-sub-list">${subs.map((sub, i) => subRowHtml(step, sub, parentIdx, i, subs)).join('')}</ol>` : ''}
        <div class="beta-sub-add">
          <input class="form-input" data-sub-new="${esc(step.id)}" type="text" placeholder="e.g. Install OS, create local admin" />
          <button type="button" class="btn-secondary" data-sub-add="${esc(step.id)}">Add sub-step</button>
        </div>
      </div>
    `;
  }

  function stepRowHtml(step, idx, stageSteps, titleId) {
    const owner = titleId || selectedTitleId;
    return `
      <li class="beta-step ${isRequired(step) ? '' : 'is-optional'}" data-step-id="${esc(step.id)}">
        <div class="beta-step-index">${idx + 1}</div>
        <div class="beta-step-body">
          <label class="beta-stage-name-wrap">
            <span class="form-label">Step name</span>
            <input class="form-input beta-step-name" data-step-label="${esc(step.id)}" value="${esc(step.label)}" placeholder="What is this step?" />
          </label>
          <label class="beta-stage-name-wrap">
            <span class="form-label">Job title and stage</span>
            <select class="form-input" data-step-move="${esc(step.id)}" aria-label="Move this step to another job title or stage">
              ${groupedStageOptionsHtml(waitTargets(null, null), waitValue(owner, step.stageId), { withTitle: true })}
            </select>
          </label>
          <p class="beta-bench-sub">Open this list and pick another job title to move the step. Notes and sub-steps come with it.</p>
          ${requiredNeedRadios(step)}
          ${stepOutcomeRadios(step)}
          ${step.outcome === 'data' ? `<div class="beta-step-fields">${fieldChecksHtml(step.outputs || [], { stepId: step.id })}</div>` : ''}
          <label class="beta-step-notes">
            <span class="form-label">Notes for the person doing this</span>
            <textarea class="form-input beta-step-notes-input" data-step-notes="${esc(step.id)}" rows="2" placeholder="Context, how to do it, or anything they should know">${esc(step.notes || '')}</textarea>
          </label>
          ${subsBlockHtml(step, idx)}
        </div>
        <div class="beta-step-actions">
          <button type="button" class="btn-xs" data-step-up="${esc(step.id)}" ${idx === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button type="button" class="btn-xs" data-step-down="${esc(step.id)}" ${idx === stageSteps.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button type="button" class="btn-xs danger" data-step-del="${esc(step.id)}">Remove</button>
        </div>
      </li>
    `;
  }

  function stageBlockHtml(stage, stages, titleId) {
    const stageSteps = stepsInStage(titleId, stage.id);
    const rows = stageSteps.length
      ? stageSteps.map((step, idx) => stepRowHtml(step, idx, stageSteps, titleId)).join('')
      : `<li class="beta-empty">No steps in this stage yet.</li>`;
    return `
      <section class="beta-stage" data-stage-id="${esc(stage.id)}">
        <div class="beta-stage-head">
          <div class="beta-kicker">Stage</div>
          <label class="beta-stage-name-wrap">
            <span class="form-label">Stage name</span>
            <input class="form-input beta-stage-name" data-stage-label="${esc(stage.id)}" value="${esc(stage.label)}" placeholder="e.g. Through BG/DS" />
          </label>
          <p class="beta-bench-sub">${esc(whenSummary(stage.when, titleId))}</p>
          ${stageWhenControls(stage, stages, titleId)}
          <div class="beta-stage-actions">
            <button type="button" class="btn-xs" data-stage-gate="${esc(stage.id)}">Gate later stages</button>
            ${stages.length > 1 ? `<button type="button" class="btn-xs danger" data-stage-del="${esc(stage.id)}">Remove stage</button>` : ''}
          </div>
        </div>
        <ol class="beta-steps">${rows}</ol>
      </section>
    `;
  }

  function render() {
    const root = document.getElementById('beta-root');
    if (!root) return;
    ensureSelection();
    const dept = selectedDept();
    const title = selectedTitle();
    const steps = title ? stepsFor(title.id) : [];
    const stages = title ? stagesFor(title.id) : [];

    const deptChips = data.departments.map((d) =>
      `<button type="button" class="beta-role ${d.id === selectedDeptId ? 'is-on' : ''}" data-beta-dept="${esc(d.id)}">${esc(d.label)}<span class="beta-role-n">${d.titles.length} title${d.titles.length === 1 ? '' : 's'}</span></button>`
    ).join('');

    const titleChips = dept
      ? (dept.titles || []).map((t) =>
          `<button type="button" class="beta-role ${t.id === selectedTitleId ? 'is-on' : ''}" data-beta-title="${esc(t.id)}">${esc(t.label)}<span class="beta-role-n">${stepsFor(t.id).length}</span></button>`
        ).join('')
      : '';

    const stageBlocks = title
      ? stages.map((stage) => stageBlockHtml(stage, stages, title.id)).join('')
      : '';

    const stageOptions = stages.map((s) =>
      `<option value="${esc(s.id)}" ${s.id === selectedStageId ? 'selected' : ''}>${esc(s.label)}</option>`
    ).join('');

    const mast = `
      <div class="beta-mast">
        <span class="beta-stamp">Process</span>
        <div>
          <h1 class="beta-title">${betaView === 'gates' ? 'Flow preview' : 'Process'}</h1>
          <p class="beta-lede">${betaView === 'gates'
            ? 'The process reads top to bottom. A stage sits under the work it waits on — including another job title. Click a stage to change the gate. This is what the live checklist uses.'
            : 'Departments, job titles, stages, and steps. Edits here drive the live New Hire Checklist for every hire.'}</p>
        </div>
      </div>
      ${viewToggleHtml()}
    `;

    if (betaView === 'gates') {
      root.innerHTML = `
        <div class="beta-shell">
          ${mast}
          ${gateMapHtml()}
        </div>
      `;
      bind(root);
      const canvas = root.querySelector('#beta-flow-canvas');
      if (canvas) canvas.scrollTop = mapScrollTop;
      return;
    }

    root.innerHTML = `
      <div class="beta-shell">
        ${mast}
        ${catalogHtml()}
        <div class="beta-layout beta-layout-3">
          <aside class="beta-roles" aria-label="Departments">
            <div class="beta-kicker">Departments</div>
            <div class="beta-role-list">${deptChips}</div>
            <div class="beta-add-role">
              <input class="form-input" id="beta-new-dept" type="text" placeholder="New department" />
              <button type="button" class="btn-secondary" id="beta-add-dept">Add department</button>
            </div>
            ${dept ? `<button type="button" class="beta-role-del" id="beta-del-dept">Remove ${esc(dept.label)}</button>` : ''}
          </aside>
          <aside class="beta-roles" aria-label="Job titles">
            <div class="beta-kicker">Job titles</div>
            ${dept ? `
              <div class="beta-role-list">${titleChips || '<div class="beta-empty">No job titles in this department yet.</div>'}</div>
              <div class="beta-add-role">
                <input class="form-input" id="beta-new-title" type="text" placeholder="New job title" />
                <button type="button" class="btn-secondary" id="beta-add-title">Add title</button>
              </div>
              ${title ? `<button type="button" class="beta-role-del" id="beta-del-title">Remove ${esc(title.label)}</button>` : ''}
            ` : '<div class="beta-empty">Select a department.</div>'}
          </aside>
          <section class="beta-bench" aria-label="Steps for selected job title">
            ${title ? `
              <div class="beta-bench-head">
                <div class="beta-kicker">${esc(dept.label)} · job title</div>
                <h2 class="beta-bench-title">${esc(title.label)}</h2>
                <p class="beta-bench-sub">${steps.length} step${steps.length === 1 ? '' : 's'} in ${stages.length} stage${stages.length === 1 ? '' : 's'} · wait on this title or another (Recruiter, HR, IT)</p>
              </div>
              ${stageBlocks || `<div class="beta-empty">No stages yet.</div>`}
              <div class="beta-add-role beta-stage-add">
                <input class="form-input" id="beta-new-stage" type="text" placeholder="New stage name, e.g. After clearance" />
                <select class="form-input" id="beta-new-stage-wait">
                  ${waitOptionsHtml(
                    waitTargets(null, null),
                    stages.length ? waitValue(title.id, stages[stages.length - 1].id) : '',
                    'No wait — can start anytime'
                  )}
                </select>
                <button type="button" class="btn-secondary" id="beta-add-stage">Add stage</button>
              </div>
              <form class="beta-composer" id="beta-add-form">
                <div class="beta-kicker">Add a step</div>
                <input class="form-input" id="beta-new-step" type="text" placeholder="What does the ${esc(title.label)} do?" value="${esc(addDraftLabel)}" required />
                <label class="form-label">Stage</label>
                <select class="form-input" id="beta-add-stage-select">${stageOptions}</select>
                <div class="beta-outcome-picks" role="radiogroup" aria-label="Required or optional">
                  <label class="beta-pick ${addRequired ? 'is-on' : ''}">
                    <input type="radio" name="beta-new-required" value="1" ${addRequired ? 'checked' : ''}>
                    <strong>Required</strong>
                    <span>Must be done before this stage can complete.</span>
                  </label>
                  <label class="beta-pick ${addRequired ? '' : 'is-on'}">
                    <input type="radio" name="beta-new-required" value="0" ${addRequired ? '' : 'checked'}>
                    <strong>Optional</strong>
                    <span>Can be skipped. Does not block the stage or parent step.</span>
                  </label>
                </div>
                <div class="beta-outcome-picks beta-outcome-picks-3" role="radiogroup" aria-label="Step result">
                  <label class="beta-pick ${addOutcome === 'confirm' ? 'is-on' : ''}">
                    <input type="radio" name="beta-new-outcome" value="confirm" ${addOutcome === 'confirm' ? 'checked' : ''}>
                    <strong>Confirmation only</strong>
                    <span>Mark the step done. No email, phone, or other value is stored.</span>
                  </label>
                  <label class="beta-pick ${addOutcome === 'data' ? 'is-on' : ''}">
                    <input type="radio" name="beta-new-outcome" value="data" ${addOutcome === 'data' ? 'checked' : ''}>
                    <strong>Produces data</strong>
                    <span>This step captures one or more values from the What data list.</span>
                  </label>
                  <label class="beta-pick ${addOutcome === 'decision' ? 'is-on' : ''}">
                    <input type="radio" name="beta-new-outcome" value="decision" ${addOutcome === 'decision' ? 'checked' : ''}>
                    <strong>Decision</strong>
                    <span>Pass, fail, or review required. Use this as the stage gate (BG/DS).</span>
                  </label>
                </div>
                <div class="beta-composer-data${addOutcome === 'data' ? '' : ' is-collapsed'}">
                  <label class="form-label">What data? Check all this step produces</label>
                  ${fieldChecksHtml(addFieldIds, { add: true })}
                </div>
                <label class="beta-step-notes">
                  <span class="form-label">Notes for the person doing this</span>
                  <textarea class="form-input beta-step-notes-input" id="beta-new-notes" rows="2" placeholder="Optional — context they will see when they do this step">${esc(addDraftNotes)}</textarea>
                </label>
                <button type="submit" class="btn-primary">Add ${esc(title.label)} step</button>
              </form>
            ` : `<div class="beta-empty">${dept ? 'Add or select a job title to define its steps.' : 'Select a department, then a job title.'}</div>`}
          </section>
        </div>
      </div>
    `;
    bind(root);
  }

  function moveStep(id, dir) {
    const list = stepsFor(selectedTitleId);
    const step = list.find((s) => s.id === id);
    if (!step) return;
    const peers = list.map((s, i) => ({ s, i })).filter((x) => x.s.stageId === step.stageId);
    const pos = peers.findIndex((x) => x.s.id === id);
    const swap = peers[pos + dir];
    if (pos < 0 || !swap) return;
    const tmp = list[peers[pos].i];
    list[peers[pos].i] = list[swap.i];
    list[swap.i] = tmp;
    persist();
    render();
  }

  function moveStepAcross(stepId, destTitleId, destStageId) {
    const fromTitle = selectedTitleId;
    if (!fromTitle || !destTitleId || !destStageId) return;
    const src = stepsFor(fromTitle);
    const idx = src.findIndex((s) => s.id === stepId);
    if (idx < 0) return;
    const destStages = stagesFor(destTitleId);
    const destStage = destStages.find((s) => s.id === destStageId);
    if (!destStage) return;
    if (fromTitle === destTitleId && src[idx].stageId === destStageId) return;
    const step = src[idx];
    src.splice(idx, 1);
    step.stageId = destStage.id;
    const dest = stepsFor(destTitleId);
    step.order = dest.length;
    dest.push(step);
    persist();
    render();
  }

  function moveSub(parentId, subId, dir) {
    const step = findOwnedStep(parentId);
    if (!step || !Array.isArray(step.subs)) return;
    const pos = step.subs.findIndex((s) => s.id === subId);
    const swap = pos + dir;
    if (pos < 0 || swap < 0 || swap >= step.subs.length) return;
    const tmp = step.subs[pos];
    step.subs[pos] = step.subs[swap];
    step.subs[swap] = tmp;
    persist();
    render();
  }

  function addSubStep(root, parentId) {
    const step = findOwnedStep(parentId);
    if (!step) return;
    const box = Array.from(root.querySelectorAll('[data-sub-add]')).find((el) => el.getAttribute('data-sub-add') === parentId);
    const inp = box && box.closest('.beta-sub-add') ? box.closest('.beta-sub-add').querySelector('[data-sub-new]') : null;
    const label = String(inp && inp.value || '').trim();
    if (!label) {
      alert('Enter a sub-step name.');
      return;
    }
    if (!Array.isArray(step.subs)) step.subs = [];
    step.subs.push(normalizeSub({
      id: uid('bss'),
      label,
      notes: '',
      outcome: 'confirm',
      required: true,
      order: step.subs.length
    }, step.subs.length, data.dataFields));
    persist();
    render();
  }

  function bindNameField(inp, commit) {
    inp.addEventListener('change', commit);
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        inp.blur();
      }
    });
  }

  function ensureNamedStage(titleId, label, when) {
    const stages = stagesFor(titleId);
    const found = stages.find((s) => String(s.label).toLowerCase() === String(label).toLowerCase());
    if (found) {
      found.when = when;
      return found;
    }
    const id = slugFrom(label, new Set(stages.map((s) => s.id)));
    const stage = { id, label, order: stages.length, when };
    stages.push(stage);
    return stage;
  }

  function gateLaterStages(stageId) {
    const stage = stagesFor(selectedTitleId).find((s) => s.id === stageId);
    if (!stage) return;
    const inStage = stepsInStage(selectedTitleId, stageId);
    if (!inStage.length) {
      alert('Add a step in this stage first. That step becomes the Pass / Fail / Review required gate.');
      return;
    }
    const gate = inStage.filter((s) => s.outcome === 'decision').pop() || inStage[inStage.length - 1];
    gate.outcome = 'decision';
    gate.outputs = [];
    ensureNamedStage(selectedTitleId, 'After clearance', { type: 'gate', titleId: selectedTitleId, stageId, result: 'pass' });
    const failStage = ensureNamedStage(selectedTitleId, 'Rescind offer', { type: 'gate', titleId: selectedTitleId, stageId, result: 'fail' });
    if (!stepsInStage(selectedTitleId, failStage.id).length) {
      const list = stepsFor(selectedTitleId);
      list.push(normalizeStep({
        id: uid('bs'),
        label: 'Rescind the offer',
        notes: 'Background or drug screen failed. Stop onboarding and rescind the offer.',
        outcome: 'confirm',
        stageId: failStage.id,
        order: list.length
      }, list.length, data.dataFields));
    }
    persist();
    render();
  }

  function bind(root) {
    root.querySelectorAll('[data-beta-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        betaView = btn.getAttribute('data-beta-view') === 'gates' ? 'gates' : 'build';
        render();
      });
    });
    root.querySelectorAll('[data-gate-title]').forEach((btn) => {
      btn.addEventListener('click', () => {
        mapTitleId = btn.getAttribute('data-gate-title');
        mapStageId = btn.getAttribute('data-gate-stage');
        render();
      });
    });
    root.querySelectorAll('[data-flow-steps]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.getAttribute('data-flow-steps');
        const parsed = parseWaitValue(key);
        if (parsed) {
          mapTitleId = parsed.titleId;
          mapStageId = parsed.stageId;
        }
        if (mapShowAllSteps) {
          mapShowAllSteps = false;
          orderedFlowNodes().forEach((n) => {
            if (n.key !== key) mapOpenSteps.add(n.key);
          });
          mapOpenSteps.delete(key);
        } else if (mapOpenSteps.has(key)) {
          mapOpenSteps.delete(key);
        } else {
          mapOpenSteps.add(key);
        }
        render();
      });
    });
    root.querySelectorAll('[data-flow-all]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.getAttribute('data-flow-all') === 'on') {
          mapShowAllSteps = true;
          mapOpenSteps.clear();
        } else {
          mapShowAllSteps = false;
          mapOpenSteps.clear();
        }
        render();
      });
    });
    root.querySelector('#beta-flow-canvas')?.addEventListener('scroll', (e) => {
      mapScrollTop = e.currentTarget.scrollTop;
    }, { passive: true });
    root.querySelector('[data-flow-export="pdf"]')?.addEventListener('click', exportFlowPdf);
    root.querySelector('[data-flow-export="xlsx"]')?.addEventListener('click', exportFlowExcel);
    root.querySelector('[data-beta-open-process]')?.addEventListener('click', () => {
      const tid = root.querySelector('[data-beta-open-process]').getAttribute('data-beta-open-process');
      const meta = titleMeta(tid);
      if (meta) {
        selectedDeptId = meta.dept.id;
        selectedTitleId = tid;
        selectedStageId = mapStageId;
      }
      betaView = 'build';
      render();
    });
    root.querySelectorAll('[data-beta-dept]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedDeptId = btn.getAttribute('data-beta-dept');
        selectedTitleId = null;
        render();
      });
    });
    root.querySelectorAll('[data-beta-title]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedTitleId = btn.getAttribute('data-beta-title');
        render();
      });
    });
    root.querySelector('#beta-add-dept')?.addEventListener('click', () => {
      const label = String(root.querySelector('#beta-new-dept')?.value || '').trim();
      if (!label) {
        alert('Enter a department name.');
        return;
      }
      const id = slugFrom(label, new Set(data.departments.map((d) => d.id)));
      data.departments.push({ id, label, titles: [] });
      selectedDeptId = id;
      selectedTitleId = null;
      persist();
      render();
    });
    root.querySelector('#beta-del-dept')?.addEventListener('click', () => {
      const dept = selectedDept();
      if (!dept) return;
      const n = titleCount(dept);
      if (!confirm(`Remove ${dept.label}, its job titles, and ${n} step(s)?`)) return;
      (dept.titles || []).forEach((t) => {
        clearGatesTo(t.id, null);
        delete data.stepsByTitle[t.id];
        if (data.stagesByTitle) delete data.stagesByTitle[t.id];
      });
      data.departments = data.departments.filter((d) => d.id !== dept.id);
      selectedDeptId = data.departments[0] ? data.departments[0].id : null;
      selectedTitleId = null;
      persist();
      render();
    });
    root.querySelector('#beta-add-title')?.addEventListener('click', () => {
      const dept = selectedDept();
      if (!dept) return;
      const label = String(root.querySelector('#beta-new-title')?.value || '').trim();
      if (!label) {
        alert('Enter a job title.');
        return;
      }
      const used = allTitleIds(data.departments);
      const id = slugFrom(label, used);
      dept.titles.push({ id, label });
      data.stepsByTitle[id] = [];
      if (!data.stagesByTitle) data.stagesByTitle = {};
      data.stagesByTitle[id] = [];
      selectedTitleId = id;
      persist();
      render();
    });
    root.querySelector('#beta-del-title')?.addEventListener('click', () => {
      const dept = selectedDept();
      const title = selectedTitle();
      if (!dept || !title) return;
      if (!confirm(`Remove ${title.label} and its ${stepsFor(title.id).length} step(s)?`)) return;
      dept.titles = dept.titles.filter((t) => t.id !== title.id);
      delete data.stepsByTitle[title.id];
      if (data.stagesByTitle) delete data.stagesByTitle[title.id];
      clearGatesTo(title.id, null);
      selectedTitleId = dept.titles[0] ? dept.titles[0].id : null;
      persist();
      render();
    });
    root.querySelectorAll('[data-stage-label]').forEach((inp) => {
      const commit = () => {
        const stage = stagesFor(selectedTitleId).find((s) => s.id === inp.getAttribute('data-stage-label'));
        if (!stage) return;
        const next = String(inp.value || '').trim();
        if (!next) {
          inp.value = stage.label;
          return;
        }
        if (next === stage.label) return;
        stage.label = next;
        persist();
        render();
      };
      inp.addEventListener('change', commit);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          inp.blur();
        }
      });
    });
    root.querySelectorAll('[data-stage-wait]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const ownerId = sel.getAttribute('data-wait-title') || selectedTitleId;
        const stage = stagesFor(ownerId).find((s) => s.id === sel.getAttribute('data-stage-wait'));
        if (!stage) return;
        const val = sel.value;
        if (!val || val === 'always') {
          stage.when = { type: 'always' };
        } else {
          const parsed = parseWaitValue(val);
          if (!parsed) {
            stage.when = { type: 'always' };
          } else {
            const resultSel = Array.from(root.querySelectorAll('[data-stage-wait-result]')).find((el) =>
              el.getAttribute('data-stage-wait-result') === stage.id && el.getAttribute('data-wait-title') === ownerId
            );
            const keep = resultSel && resultSel.value;
            const result = stageHasDecision(parsed.titleId, parsed.stageId)
              ? (keep && GATE_RESULTS.some((r) => r.id === keep) ? keep : 'complete')
              : 'complete';
            stage.when = { type: 'gate', titleId: parsed.titleId, stageId: parsed.stageId, result };
          }
        }
        persist();
        render();
      });
    });
    root.querySelectorAll('[data-stage-wait-result]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const ownerId = sel.getAttribute('data-wait-title') || selectedTitleId;
        const stage = stagesFor(ownerId).find((s) => s.id === sel.getAttribute('data-stage-wait-result'));
        if (!stage || !stage.when || stage.when.type !== 'gate') return;
        stage.when.result = GATE_RESULTS.some((r) => r.id === sel.value) ? sel.value : 'complete';
        persist();
        render();
      });
    });
    root.querySelectorAll('[data-stage-gate]').forEach((btn) => {
      btn.addEventListener('click', () => gateLaterStages(btn.getAttribute('data-stage-gate')));
    });
    root.querySelector('#beta-add-stage')?.addEventListener('click', () => {
      const label = String(root.querySelector('#beta-new-stage')?.value || '').trim();
      if (!label) {
        alert('Enter a stage name.');
        return;
      }
      const stages = stagesFor(selectedTitleId);
      const id = slugFrom(label, new Set(stages.map((s) => s.id)));
      const wait = String(root.querySelector('#beta-new-stage-wait')?.value || 'always');
      let when = { type: 'always' };
      const parsed = parseWaitValue(wait);
      if (parsed) {
        when = { type: 'gate', titleId: parsed.titleId, stageId: parsed.stageId, result: 'complete' };
      }
      stages.push({ id, label, order: stages.length, when });
      selectedStageId = id;
      persist();
      render();
    });
    root.querySelectorAll('[data-stage-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const stages = stagesFor(selectedTitleId);
        if (stages.length < 2) return;
        const id = btn.getAttribute('data-stage-del');
        const stage = stages.find((s) => s.id === id);
        if (!stage) return;
        const n = stepsInStage(selectedTitleId, id).length;
        if (!confirm(n ? `Remove “${stage.label}” and move its ${n} step(s) into the first stage?` : `Remove “${stage.label}”?`)) return;
        const keep = stages.find((s) => s.id !== id);
        stepsFor(selectedTitleId).forEach((step) => {
          if (step.stageId === id) step.stageId = keep.id;
        });
        data.stagesByTitle[selectedTitleId] = stages.filter((s) => s.id !== id).map((s, i) =>
          Object.assign({}, s, { order: i })
        );
        clearGatesTo(selectedTitleId, id);
        selectedStageId = keep.id;
        persist();
        render();
      });
    });
    root.querySelector('#beta-add-stage-select')?.addEventListener('change', (e) => {
      selectedStageId = e.target.value;
    });
    root.querySelectorAll('[data-step-label]').forEach((inp) => {
      bindNameField(inp, () => {
        const step = findOwnedStep(inp.getAttribute('data-step-label'));
        if (!step) return;
        const next = String(inp.value || '').trim();
        if (!next) {
          inp.value = step.label;
          return;
        }
        if (next === step.label) return;
        step.label = next;
        persist();
      });
    });
    root.querySelectorAll('[data-sub-label]').forEach((inp) => {
      bindNameField(inp, () => {
        const sub = findOwnedSub(inp.getAttribute('data-parent'), inp.getAttribute('data-sub-label'));
        if (!sub) return;
        const next = String(inp.value || '').trim();
        if (!next) {
          inp.value = sub.label;
          return;
        }
        if (next === sub.label) return;
        sub.label = next;
        persist();
      });
    });
    root.querySelectorAll('[data-step-required]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const step = findOwnedStep(inp.getAttribute('data-step-required'));
        if (!step) return;
        step.required = inp.value !== '0';
        persist();
        render();
      });
    });
    root.querySelectorAll('[data-sub-required]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const sub = findOwnedSub(inp.getAttribute('data-parent'), inp.getAttribute('data-sub-required'));
        if (!sub) return;
        sub.required = inp.value !== '0';
        persist();
        render();
      });
    });
    root.querySelectorAll('[data-step-outcome]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const step = stepsFor(selectedTitleId).find((s) => s.id === inp.getAttribute('data-step-outcome'));
        if (!step) return;
        step.outcome = setOutcome(inp.value);
        if (step.outcome === 'data' && !(step.outputs || []).length) step.outputs = addFieldIds.slice();
        if (step.outcome !== 'data') step.outputs = [];
        persist();
        render();
      });
    });
    root.querySelectorAll('[data-sub-outcome]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const sub = findOwnedSub(inp.getAttribute('data-parent'), inp.getAttribute('data-sub-outcome'));
        if (!sub) return;
        sub.outcome = inp.value === 'data' ? 'data' : 'confirm';
        if (sub.outcome === 'data' && !(sub.outputs || []).length) sub.outputs = addFieldIds.slice();
        if (sub.outcome !== 'data') sub.outputs = [];
        persist();
        render();
      });
    });
    root.querySelectorAll('[data-step-output]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const step = stepsFor(selectedTitleId).find((s) => s.id === inp.getAttribute('data-step-output'));
        if (!step) return;
        const id = inp.value;
        const set = new Set(step.outputs || []);
        if (inp.checked) set.add(id);
        else set.delete(id);
        step.outputs = [...set];
        persist();
        inp.closest('.beta-field-check')?.classList.toggle('is-on', inp.checked);
      });
    });
    root.querySelectorAll('[data-sub-output]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const sub = findOwnedSub(inp.getAttribute('data-sub-output'), inp.getAttribute('data-sub-id'));
        if (!sub) return;
        const id = inp.value;
        const set = new Set(sub.outputs || []);
        if (inp.checked) set.add(id);
        else set.delete(id);
        sub.outputs = [...set];
        persist();
        inp.closest('.beta-field-check')?.classList.toggle('is-on', inp.checked);
      });
    });
    root.querySelectorAll('[data-add-field]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const id = inp.getAttribute('data-add-field');
        const set = new Set(addFieldIds);
        if (inp.checked) set.add(id);
        else set.delete(id);
        addFieldIds = [...set];
        inp.closest('.beta-field-check')?.classList.toggle('is-on', inp.checked);
      });
    });
    root.querySelectorAll('[data-step-up]').forEach((btn) => {
      btn.addEventListener('click', () => moveStep(btn.getAttribute('data-step-up'), -1));
    });
    root.querySelectorAll('[data-step-down]').forEach((btn) => {
      btn.addEventListener('click', () => moveStep(btn.getAttribute('data-step-down'), 1));
    });
    root.querySelectorAll('[data-step-move]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const parsed = parseWaitValue(sel.value);
        if (!parsed) return;
        moveStepAcross(sel.getAttribute('data-step-move'), parsed.titleId, parsed.stageId);
      });
    });
    root.querySelectorAll('[data-step-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        data.stepsByTitle[selectedTitleId] = stepsFor(selectedTitleId).filter((s) => s.id !== btn.getAttribute('data-step-del'));
        persist();
        render();
      });
    });
    root.querySelectorAll('[data-sub-add]').forEach((btn) => {
      btn.addEventListener('click', () => addSubStep(root, btn.getAttribute('data-sub-add')));
    });
    root.querySelectorAll('[data-sub-new]').forEach((inp) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addSubStep(root, inp.getAttribute('data-sub-new'));
        }
      });
    });
    root.querySelectorAll('[data-sub-up]').forEach((btn) => {
      btn.addEventListener('click', () => moveSub(btn.getAttribute('data-parent'), btn.getAttribute('data-sub-up'), -1));
    });
    root.querySelectorAll('[data-sub-down]').forEach((btn) => {
      btn.addEventListener('click', () => moveSub(btn.getAttribute('data-parent'), btn.getAttribute('data-sub-down'), 1));
    });
    root.querySelectorAll('[data-sub-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const step = findOwnedStep(btn.getAttribute('data-parent'));
        if (!step || !Array.isArray(step.subs)) return;
        const id = btn.getAttribute('data-sub-del');
        step.subs = step.subs.filter((s) => s.id !== id);
        persist();
        render();
      });
    });
    root.querySelector('#beta-new-step')?.addEventListener('input', (e) => {
      addDraftLabel = String(e.target.value || '');
    });
    root.querySelector('#beta-new-notes')?.addEventListener('input', (e) => {
      addDraftNotes = String(e.target.value || '');
    });
    root.querySelectorAll('[data-step-notes]').forEach((inp) => {
      const commit = (trim) => {
        const step = stepsFor(selectedTitleId).find((s) => s.id === inp.getAttribute('data-step-notes'));
        if (!step) return;
        const next = String(inp.value || '');
        step.notes = trim ? next.trim() : next;
        if (trim && inp.value !== step.notes) inp.value = step.notes;
        persist();
      };
      inp.addEventListener('input', () => commit(false));
      inp.addEventListener('blur', () => commit(true));
    });
    root.querySelectorAll('[data-sub-notes]').forEach((inp) => {
      const commit = (trim) => {
        const sub = findOwnedSub(inp.getAttribute('data-parent'), inp.getAttribute('data-sub-notes'));
        if (!sub) return;
        const next = String(inp.value || '');
        sub.notes = trim ? next.trim() : next;
        if (trim && inp.value !== sub.notes) inp.value = sub.notes;
        persist();
      };
      inp.addEventListener('input', () => commit(false));
      inp.addEventListener('blur', () => commit(true));
    });
    root.querySelectorAll('input[name="beta-new-outcome"]').forEach((inp) => {
      inp.addEventListener('change', () => {
        addDraftLabel = String(root.querySelector('#beta-new-step')?.value || '');
        addDraftNotes = String(root.querySelector('#beta-new-notes')?.value || '');
        addOutcome = setOutcome(inp.value);
        render();
      });
    });
    root.querySelectorAll('input[name="beta-new-required"]').forEach((inp) => {
      inp.addEventListener('change', () => {
        addDraftLabel = String(root.querySelector('#beta-new-step')?.value || '');
        addDraftNotes = String(root.querySelector('#beta-new-notes')?.value || '');
        addRequired = inp.value !== '0';
        render();
      });
    });
    root.querySelector('#beta-add-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!selectedTitleId) return;
      const label = String(root.querySelector('#beta-new-step')?.value || '').trim();
      if (!label) {
        alert('Enter a step name.');
        return;
      }
      if (addOutcome === 'data' && !addFieldIds.length) {
        alert('Check at least one data field, or choose Confirmation only.');
        return;
      }
      const stageId = String(root.querySelector('#beta-add-stage-select')?.value || selectedStageId || '');
      selectedStageId = stageId || selectedStageId;
      const list = stepsFor(selectedTitleId);
      list.push(normalizeStep({
        id: uid('bs'),
        label,
        notes: addDraftNotes,
        outcome: addOutcome,
        outputs: addOutcome === 'data' ? addFieldIds.slice() : [],
        required: addRequired,
        stageId: selectedStageId,
        order: list.length
      }, list.length, data.dataFields));
      addDraftLabel = '';
      addDraftNotes = '';
      addRequired = true;
      persist();
      render();
      const next = document.getElementById('beta-new-step');
      if (next) next.focus();
    });
    root.querySelector('#beta-catalog-toggle')?.addEventListener('click', () => {
      catalogOpen = !catalogOpen;
      render();
    });
    root.querySelectorAll('[data-df-label]').forEach((inp) => {
      const commit = () => {
        const f = (data.dataFields || []).find((x) => x.id === inp.getAttribute('data-df-label'));
        if (!f) return;
        const next = String(inp.value || '').trim();
        if (!next) {
          inp.value = f.label;
          return;
        }
        f.label = next;
        persist();
      };
      inp.addEventListener('change', commit);
      inp.addEventListener('blur', commit);
    });
    root.querySelectorAll('[data-df-input]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const f = (data.dataFields || []).find((x) => x.id === sel.getAttribute('data-df-input'));
        if (!f) return;
        f.input = sel.value;
        persist();
      });
    });
    root.querySelectorAll('[data-df-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-df-del');
        const f = (data.dataFields || []).find((x) => x.id === id);
        if (!f) return;
        if (!confirm(`Remove “${f.label}” from What data? Steps that used it will drop that field.`)) return;
        data.dataFields = data.dataFields.filter((x) => x.id !== id);
        addFieldIds = addFieldIds.filter((x) => x !== id);
        Object.keys(data.stepsByTitle || {}).forEach((titleId) => {
          (data.stepsByTitle[titleId] || []).forEach((step) => {
            step.outputs = (step.outputs || []).filter((oid) => oid !== id);
            (step.subs || []).forEach((sub) => {
              sub.outputs = (sub.outputs || []).filter((oid) => oid !== id);
            });
          });
        });
        persist();
        render();
      });
    });
    root.querySelector('#beta-add-field')?.addEventListener('click', () => {
      const label = String(root.querySelector('#beta-new-field')?.value || '').trim();
      if (!label) {
        alert('Enter a field name.');
        return;
      }
      const input = root.querySelector('#beta-new-field-input')?.value || 'text';
      const id = slugFrom(label, new Set((data.dataFields || []).map((f) => f.id)));
      data.dataFields = data.dataFields || [];
      data.dataFields.push({ id, label, input });
      addFieldIds = [...new Set([...addFieldIds, id])];
      catalogOpen = true;
      persist();
      render();
    });
  }

  function applyRemote(raw) {
    const seedRequired = incomingNeedsRequiredSeed(raw);
    data = normalize(raw);
    if (selectedDeptId && !data.departments.some((d) => d.id === selectedDeptId)) selectedDeptId = null;
    const dept = selectedDept();
    if (selectedTitleId && !(dept && dept.titles.some((t) => t.id === selectedTitleId))) selectedTitleId = null;
    if (seedRequired) persist();
  }

  const TITLE_OWNERS = {
    recruiter: { role: 'HR', assignee: 'Jessa' },
    vp_people_ops: { role: 'HR', assignee: 'Lisa' },
    payroll_ap_hr: { role: 'HR', assignee: 'Lisa' },
    it_manager: { role: 'Admin', assignee: 'Ana' },
    logistics_manager: { role: 'Logistics', assignee: 'Joe' },
    logistics_support: { role: 'Logistics', assignee: 'Joe' },
    training_coordinator: { role: 'Training', assignee: 'Paula' },
    assistant_training_coordinator: { role: 'Training', assignee: 'Brenda' }
  };

  function seedRoles() {
    const raw = window.NEW_HIRE_SEED && NEW_HIRE_SEED.roles;
    return Array.isArray(raw) ? JSON.parse(JSON.stringify(raw)) : [];
  }

  function ownerForTitle(dept, title) {
    const mapped = TITLE_OWNERS[title.id];
    if (mapped) return mapped;
    const roles = seedRoles();
    const role = roles.find((r) => String(r.label).toLowerCase() === String(dept.label).toLowerCase())
      || roles.find((r) => r.id === dept.id);
    const people = (role && role.people) || [];
    return {
      role: (role && role.id) || dept.label || 'HR',
      assignee: people[0] || ''
    };
  }

  function compileStepInput(step) {
    if (step.outcome === 'decision') {
      return { inputType: 'select', options: ['Pass', 'Fail', 'Review required', 'Complete'] };
    }
    if (step.outcome === 'data') {
      const catalog = data.dataFields || [];
      const first = (step.outputs || []).map((id) => catalog.find((f) => f.id === id)).find(Boolean);
      let inputType = first && first.input ? first.input : 'text';
      if (inputType === 'file' || inputType === 'email' || inputType === 'phone') inputType = 'text';
      return { inputType, options: [] };
    }
    return { inputType: 'checkbox', options: [] };
  }

  function compileChecklistTemplate() {
    const nodes = orderedFlowNodes();
    const roles = seedRoles();
    (data.departments || []).forEach((dept) => {
      if (!roles.some((r) => r.id === dept.id || r.label === dept.label)) {
        roles.push({ id: dept.id, label: dept.label, people: [] });
      }
    });
    const sections = [];
    const items = [];
    let order = 1;
    nodes.forEach((node, i) => {
      const owner = ownerForTitle(node.dept, node.title);
      const sectionId = flowNodeKey(node.titleId, node.stageId);
      sections.push({
        id: sectionId,
        title: `${node.title.label} · ${node.stage.label}`,
        defaultRole: owner.role,
        defaultOwner: owner.assignee,
        when: node.stage.when || { type: 'always' },
        titleId: node.titleId,
        stageId: node.stageId,
        flowIndex: i + 1
      });
      stepsInStage(node.titleId, node.stageId).forEach((step) => {
        const input = compileStepInput(step);
        items.push({
          id: step.id,
          sectionId,
          label: step.label,
          notes: step.notes || '',
          owner: owner.assignee,
          role: owner.role,
          assignee: owner.assignee,
          inputType: input.inputType,
          options: input.options,
          outcome: step.outcome || 'confirm',
          required: step.required !== false,
          dueOffsetDays: 0,
          dueDaysBefore: 0,
          dueAnchor: 'start',
          sensitive: false,
          dependsOnPrior: false,
          dependsOnTaskId: null,
          checklistSteps: (step.subs || []).map((sub) => ({
            id: sub.id,
            label: sub.label,
            required: sub.required !== false
          })),
          link: '',
          order: order++
        });
      });
    });
    return { version: 3, roles, sections, items };
  }

  function mount() {
    if (!data.departments.length) data = emptyData();
    if (!Array.isArray(data.dataFields) || !data.dataFields.length) {
      data.dataFields = DEFAULT_DATA_FIELDS.map((f) => Object.assign({}, f));
    }
    render();
  }

  window.HubBeta = {
    applyRemote,
    mount,
    compileTemplate: compileChecklistTemplate
  };
})();
