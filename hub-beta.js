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
  let addFieldIds = [];
  let addDraftLabel = '';
  let addDraftNotes = '';

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
      stagesByTitle[id] = normalizeStages(incomingStages[id], stepsByTitle[id]);
    });

    // v1: steps lived on the department-as-role. Park them on the first job title if that title is still empty.
    departments.forEach((dept) => {
      const leftover = Array.isArray(incomingRoles[dept.id]) ? incomingRoles[dept.id] : [];
      if (!leftover.length || !dept.titles.length) return;
      const firstId = dept.titles[0].id;
      if (!stepsByTitle[firstId] || !stepsByTitle[firstId].length) {
        stepsByTitle[firstId] = leftover.map((step, i) => normalizeStep(step, i, dataFields)).filter(Boolean);
        stagesByTitle[firstId] = normalizeStages(incomingStages[firstId], stepsByTitle[firstId]);
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

  function normalizeWhen(when, stageIds) {
    if (!when || when.type !== 'gate') return { type: 'always' };
    const result = GATE_RESULTS.some((r) => r.id === when.result) ? when.result : '';
    const stageId = String(when.stageId || '');
    if (!result || !stageId || (stageIds && !stageIds.has(stageId))) return { type: 'always' };
    return { type: 'gate', stageId, result };
  }

  function normalizeStages(rawStages, steps) {
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
            when: { type: s.when && s.when.type === 'gate' ? 'gate' : 'always', stageId: s.when && s.when.stageId, result: s.when && s.when.result }
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
      when: normalizeWhen(s.when, ids)
    })).sort((a, b) => a.order - b.order);
    (steps || []).forEach((step) => {
      if (!ids.has(step.stageId)) step.stageId = stages[0].id;
    });
    return stages;
  }

  function normalizeStep(step, order, fields) {
    if (!step) return null;
    const catalog = fields || data.dataFields || DEFAULT_DATA_FIELDS;
    const known = new Set(catalog.map((f) => f.id));
    let outputs = Array.isArray(step.outputs) ? step.outputs.map((id) => String(id)) : [];
    if (!outputs.length && step.dataKind) outputs = [String(step.dataKind)];
    outputs = [...new Set(outputs.filter((id) => known.has(id)))];
    let outcome = 'confirm';
    if (step.outcome === 'decision') outcome = 'decision';
    else if (step.outcome === 'data' || outputs.length) outcome = 'data';
    return {
      id: step.id || uid('bs'),
      label: String(step.label || '').trim() || 'Untitled step',
      notes: String(step.notes || '').trim(),
      outcome,
      outputs: outcome === 'data' ? outputs : [],
      stageId: String(step.stageId || ''),
      order: step.order != null ? step.order : order
    };
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
    data.stagesByTitle[titleId] = normalizeStages(data.stagesByTitle[titleId], steps);
    return data.stagesByTitle[titleId];
  }

  function stepsInStage(titleId, stageId) {
    return stepsFor(titleId).filter((s) => s.stageId === stageId);
  }

  function stageHasDecision(titleId, stageId) {
    return stepsInStage(titleId, stageId).some((s) => s.outcome === 'decision');
  }

  function gateResultLabel(id) {
    return (GATE_RESULTS.find((r) => r.id === id) || {}).label || id;
  }

  function whenSummary(when, stages) {
    if (!when || when.type !== 'gate') return 'Always open — work here does not wait on another stage.';
    const src = (stages || []).find((s) => s.id === when.stageId);
    return `Opens when ${src ? src.label : 'another stage'} is ${gateResultLabel(when.result)}. Review required holds this closed until that decision changes.`;
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
          : `data-step-output="${esc(stepId)}" value="${esc(f.id)}"`}
          ${picked.has(f.id) ? 'checked' : ''}>
        ${esc(f.label)}
        <span class="beta-field-kind">${esc(inputTypeLabel(f.input))}</span>
      </label>
    `).join('')}</div>`;
  }

  function catalogHtml() {
    const rows = (data.dataFields || []).map((f) => `
      <tr>
        <td><input class="form-input" data-df-label="${esc(f.id)}" value="${esc(f.label)}" /></td>
        <td><select class="form-input" data-df-input="${esc(f.id)}">${inputTypeOptions(f.input)}</select></td>
        <td><button type="button" class="btn-xs danger" data-df-del="${esc(f.id)}">Remove</button></td>
      </tr>
    `).join('');
    return `
      <section class="beta-catalog" aria-label="What data">
        <div class="beta-kicker">What data</div>
        <p class="beta-bench-sub">This is the shared list of data a step can produce. Use File (PDF or image) for things like a diploma or OSHA card. A step can check more than one.</p>
        <div class="nh-table-wrap">
          <table class="data-table">
            <thead><tr><th>Field name</th><th>Input</th><th></th></tr></thead>
            <tbody>${rows || '<tr><td colspan="3" class="nh-empty">No data fields yet.</td></tr>'}</tbody>
          </table>
        </div>
        <div class="beta-add-role beta-catalog-add">
          <input class="form-input" id="beta-new-field" type="text" placeholder="e.g. HS diploma" />
          <select class="form-input" id="beta-new-field-input">${inputTypeOptions('text')}</select>
          <button type="button" class="btn-secondary" id="beta-add-field">Add data field</button>
        </div>
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

  function stepOutcomeRadios(step) {
    const cur = outcomeValue(step);
    return `
      <div class="beta-step-result">
        <label class="beta-toggle">
          <input type="radio" name="out-${esc(step.id)}" data-step-outcome="${esc(step.id)}" value="confirm" ${cur === 'confirm' ? 'checked' : ''}>
          Confirmation only
        </label>
        <label class="beta-toggle">
          <input type="radio" name="out-${esc(step.id)}" data-step-outcome="${esc(step.id)}" value="data" ${cur === 'data' ? 'checked' : ''}>
          Produces data
        </label>
        <label class="beta-toggle">
          <input type="radio" name="out-${esc(step.id)}" data-step-outcome="${esc(step.id)}" value="decision" ${cur === 'decision' ? 'checked' : ''}>
          Decision
        </label>
      </div>
      ${cur === 'decision' ? '<p class="beta-gate-note">Pass continues. Fail goes to the Fail stage (rescind). Review required holds later stages until someone decides.</p>' : ''}
    `;
  }

  function stageWhenControls(stage, stages) {
    const others = stages.filter((s) => s.id !== stage.id);
    const isGate = stage.when && stage.when.type === 'gate';
    const typeVal = isGate ? stage.when.result : 'always';
    return `
      <div class="beta-stage-when">
        <label class="form-label">Opens</label>
        <select class="form-input" data-stage-when="${esc(stage.id)}">
          <option value="always" ${typeVal === 'always' ? 'selected' : ''}>Always — starting work, no wait</option>
          ${GATE_RESULTS.map((r) =>
            `<option value="${esc(r.id)}" ${typeVal === r.id ? 'selected' : ''}>When a stage is ${esc(r.label)}</option>`
          ).join('')}
        </select>
        <select class="form-input ${isGate ? '' : 'is-collapsed'}" data-stage-when-src="${esc(stage.id)}" ${isGate ? '' : 'disabled'}>
          ${others.length
            ? others.map((s) =>
                `<option value="${esc(s.id)}" ${isGate && stage.when.stageId === s.id ? 'selected' : ''}>${esc(s.label)}</option>`
              ).join('')
            : '<option value="">Add another stage first</option>'}
        </select>
      </div>
    `;
  }

  function stepRowHtml(step, idx, stageSteps) {
    return `
      <li class="beta-step" data-step-id="${esc(step.id)}">
        <div class="beta-step-index">${idx + 1}</div>
        <div class="beta-step-body">
          <input class="beta-step-name" data-step-label="${esc(step.id)}" value="${esc(step.label)}" />
          ${stepOutcomeRadios(step)}
          ${step.outcome === 'data' ? `<div class="beta-step-fields">${fieldChecksHtml(step.outputs || [], { stepId: step.id })}</div>` : ''}
          <label class="beta-step-notes">
            <span class="form-label">Notes for the person doing this</span>
            <textarea class="form-input beta-step-notes-input" data-step-notes="${esc(step.id)}" rows="2" placeholder="Context, how to do it, or anything they should know">${esc(step.notes || '')}</textarea>
          </label>
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
      ? stageSteps.map((step, idx) => stepRowHtml(step, idx, stageSteps)).join('')
      : `<li class="beta-empty">No steps in this stage yet.</li>`;
    return `
      <section class="beta-stage" data-stage-id="${esc(stage.id)}">
        <div class="beta-stage-head">
          <div class="beta-kicker">Stage</div>
          <label class="beta-stage-name-wrap">
            <span class="form-label">Stage name</span>
            <input class="form-input beta-stage-name" data-stage-label="${esc(stage.id)}" value="${esc(stage.label)}" placeholder="e.g. Through BG/DS" />
          </label>
          <p class="beta-bench-sub">${esc(whenSummary(stage.when, stages))}</p>
          ${stageWhenControls(stage, stages)}
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

    root.innerHTML = `
      <div class="beta-shell">
        <div class="beta-mast">
          <span class="beta-stamp">Beta</span>
          <div>
            <h1 class="beta-title">Role process</h1>
            <p class="beta-lede">HR, Admin, Logistics, and Training are departments. Roles are job titles inside a department. Gate by stage, not every step: later work waits on a decision like BG/DS. The live New Hire Checklist is unchanged.</p>
          </div>
        </div>
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
                <p class="beta-bench-sub">${steps.length} step${steps.length === 1 ? '' : 's'} in ${stages.length} stage${stages.length === 1 ? '' : 's'} · gate later work on Pass / Fail / Review required — not on every step</p>
              </div>
              ${stageBlocks || `<div class="beta-empty">No stages yet.</div>`}
              <div class="beta-add-role" style="margin: 0 0 18px">
                <input class="form-input" id="beta-new-stage" type="text" placeholder="New stage name, e.g. After clearance" />
                <button type="button" class="btn-secondary" id="beta-add-stage">Add stage</button>
              </div>
              <form class="beta-composer" id="beta-add-form">
                <div class="beta-kicker">Add a step</div>
                <input class="form-input" id="beta-new-step" type="text" placeholder="What does the ${esc(title.label)} do?" value="${esc(addDraftLabel)}" required />
                <label class="form-label">Stage</label>
                <select class="form-input" id="beta-add-stage-select">${stageOptions}</select>
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
    ensureNamedStage(selectedTitleId, 'After clearance', { type: 'gate', stageId, result: 'pass' });
    const failStage = ensureNamedStage(selectedTitleId, 'Rescind offer', { type: 'gate', stageId, result: 'fail' });
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
    root.querySelectorAll('[data-stage-when]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const stage = stagesFor(selectedTitleId).find((s) => s.id === sel.getAttribute('data-stage-when'));
        if (!stage) return;
        const val = sel.value;
        if (val === 'always') {
          stage.when = { type: 'always' };
        } else {
          const srcSel = root.querySelector(`[data-stage-when-src="${stage.id}"]`);
          const src = srcSel && srcSel.value;
          if (!src) {
            alert('Add another stage first, then point this one at it.');
            sel.value = 'always';
            stage.when = { type: 'always' };
          } else {
            stage.when = { type: 'gate', stageId: src, result: val };
          }
        }
        persist();
        render();
      });
    });
    root.querySelectorAll('[data-stage-when-src]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const stage = stagesFor(selectedTitleId).find((s) => s.id === sel.getAttribute('data-stage-when-src'));
        if (!stage || !stage.when || stage.when.type !== 'gate') return;
        stage.when.stageId = sel.value;
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
      const prev = stages[stages.length - 1];
      let when = { type: 'always' };
      if (prev && stageHasDecision(selectedTitleId, prev.id)) {
        when = { type: 'gate', stageId: prev.id, result: 'pass' };
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
        data.stagesByTitle[selectedTitleId] = stages.filter((s) => s.id !== id).map((s, i) => {
          const when = s.when && s.when.type === 'gate' && s.when.stageId === id ? { type: 'always' } : s.when;
          return Object.assign({}, s, { order: i, when });
        });
        selectedStageId = keep.id;
        persist();
        render();
      });
    });
    root.querySelector('#beta-add-stage-select')?.addEventListener('change', (e) => {
      selectedStageId = e.target.value;
    });
    root.querySelectorAll('[data-step-label]').forEach((inp) => {
      const commit = () => {
        const step = stepsFor(selectedTitleId).find((s) => s.id === inp.getAttribute('data-step-label'));
        if (!step) return;
        const next = String(inp.value || '').trim();
        if (!next) {
          inp.value = step.label;
          return;
        }
        step.label = next;
        persist();
      };
      inp.addEventListener('change', commit);
      inp.addEventListener('blur', commit);
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
    root.querySelectorAll('[data-step-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        data.stepsByTitle[selectedTitleId] = stepsFor(selectedTitleId).filter((s) => s.id !== btn.getAttribute('data-step-del'));
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
    root.querySelectorAll('input[name="beta-new-outcome"]').forEach((inp) => {
      inp.addEventListener('change', () => {
        addDraftLabel = String(root.querySelector('#beta-new-step')?.value || '');
        addDraftNotes = String(root.querySelector('#beta-new-notes')?.value || '');
        addOutcome = setOutcome(inp.value);
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
        stageId: selectedStageId,
        order: list.length
      }, list.length, data.dataFields));
      addDraftLabel = '';
      addDraftNotes = '';
      persist();
      render();
      const next = document.getElementById('beta-new-step');
      if (next) next.focus();
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
      persist();
      render();
    });
  }

  function applyRemote(raw) {
    data = normalize(raw);
    if (selectedDeptId && !data.departments.some((d) => d.id === selectedDeptId)) selectedDeptId = null;
    const dept = selectedDept();
    if (selectedTitleId && !(dept && dept.titles.some((t) => t.id === selectedTitleId))) selectedTitleId = null;
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
    mount
  };
})();
