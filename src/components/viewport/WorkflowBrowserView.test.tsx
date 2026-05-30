/**
 * Tests for WorkflowBrowserView.
 *
 * Mocks the workflowStore (QuestChainView.test.tsx pattern) so render state is
 * driven without a live bridge. Asserts:
 *   - the template list renders and selecting a template loads its detail
 *   - the detail surfaces steps + required-param inputs + a Run button
 *   - SAFETY: the Run button is CONFIRM-GATED — a single click only ARMS a
 *     confirmation; runWorkflow(autoExecute:true) fires ONLY after the explicit
 *     confirm step. A bare first click must NOT mass-mutate game state.
 *   - the dry-run "Preview steps" path calls runWorkflow with autoExecute:false
 *     (no confirm required — it mutates nothing).
 *   - loading / error / empty / no-active-character states render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// --- Store mocks (must precede component import) -----------------------------

const loadTemplates = vi.fn();
const loadDetail = vi.fn();
const runWorkflow = vi.fn().mockResolvedValue(undefined);
const setSelectedTemplateId = vi.fn();

function sampleTemplates() {
  return [
    { id: 'onboard-party', name: 'Onboard a Party', description: 'Create a party and members.' },
    { id: 'seed-world', name: 'Seed the World', description: 'Generate a starter world.' },
  ];
}

function sampleDetail() {
  return {
    success: true,
    actionType: 'get_template',
    template: {
      id: 'onboard-party',
      name: 'Onboard a Party',
      steps: [
        { tool: 'create_party', description: 'Create the party' },
        { tool: 'create_character', description: 'Create the leader' },
      ],
      requiredParams: ['partyName', 'leaderName'],
    },
  };
}

let workflowState: any;

vi.mock('../../stores/workflowStore', () => ({
  useWorkflowStore: vi.fn((selector: any) => selector(workflowState)),
}));

let gameStateState: any = { activeCharacterId: 'char-1' };
vi.mock('../../stores/gameStateStore', () => ({
  useGameStateStore: vi.fn((selector: any) => selector(gameStateState)),
}));

import { WorkflowBrowserView } from './WorkflowBrowserView';

describe('WorkflowBrowserView', () => {
  beforeEach(() => {
    loadTemplates.mockClear();
    loadDetail.mockClear();
    runWorkflow.mockClear().mockResolvedValue(undefined);
    setSelectedTemplateId.mockClear();
    gameStateState = { activeCharacterId: 'char-1' };
    workflowState = {
      templates: sampleTemplates(),
      selectedTemplateId: null,
      detail: null,
      lastRun: null,
      isLoading: false,
      error: null,
      loadTemplates,
      loadDetail,
      runWorkflow,
      setSelectedTemplateId,
    };
  });

  it('loads templates on mount', () => {
    render(<WorkflowBrowserView />);
    expect(loadTemplates).toHaveBeenCalled();
  });

  it('renders each template by name in the list', () => {
    render(<WorkflowBrowserView />);
    expect(screen.getByText(/Onboard a Party/i)).toBeInTheDocument();
    expect(screen.getByText(/Seed the World/i)).toBeInTheDocument();
  });

  it('selecting a template sets the selection and loads its detail', () => {
    render(<WorkflowBrowserView />);
    fireEvent.click(screen.getByTestId('workflow-template-onboard-party'));
    expect(setSelectedTemplateId).toHaveBeenCalledWith('onboard-party');
    expect(loadDetail).toHaveBeenCalledWith('onboard-party');
  });

  it('renders the detail steps + required-param inputs + a Run button when a template is selected', () => {
    workflowState = { ...workflowState, selectedTemplateId: 'onboard-party', detail: sampleDetail() };
    render(<WorkflowBrowserView />);

    // Steps surface.
    expect(screen.getByText(/create_party/i)).toBeInTheDocument();
    expect(screen.getByText(/create_character/i)).toBeInTheDocument();
    // One input per required param.
    expect(screen.getByTestId('workflow-param-partyName')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-param-leaderName')).toBeInTheDocument();
    // The Run button exists.
    expect(screen.getByTestId('workflow-run-button')).toBeInTheDocument();
  });

  it('SAFETY: a single Run click ARMS a confirm and does NOT call runWorkflow', () => {
    workflowState = { ...workflowState, selectedTemplateId: 'onboard-party', detail: sampleDetail() };
    render(<WorkflowBrowserView />);

    fireEvent.click(screen.getByTestId('workflow-run-button'));

    // The confirm prompt is now visible...
    expect(screen.getByTestId('workflow-run-confirm')).toBeInTheDocument();
    // ...and NOTHING was executed yet — no state mutation on a bare click.
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('SAFETY: runWorkflow(autoExecute:true) fires ONLY after the explicit confirm step', () => {
    workflowState = { ...workflowState, selectedTemplateId: 'onboard-party', detail: sampleDetail() };
    render(<WorkflowBrowserView />);

    // Arm, then confirm.
    fireEvent.click(screen.getByTestId('workflow-run-button'));
    fireEvent.click(screen.getByTestId('workflow-run-confirm'));

    expect(runWorkflow).toHaveBeenCalledTimes(1);
    const [templateId, , opts] = runWorkflow.mock.calls[0];
    expect(templateId).toBe('onboard-party');
    expect(opts).toEqual({ autoExecute: true });
  });

  it('forwards entered required params to runWorkflow on confirm', () => {
    workflowState = { ...workflowState, selectedTemplateId: 'onboard-party', detail: sampleDetail() };
    render(<WorkflowBrowserView />);

    fireEvent.change(screen.getByTestId('workflow-param-partyName'), { target: { value: 'The Brave' } });
    fireEvent.change(screen.getByTestId('workflow-param-leaderName'), { target: { value: 'Aria' } });

    fireEvent.click(screen.getByTestId('workflow-run-button'));
    fireEvent.click(screen.getByTestId('workflow-run-confirm'));

    const [, params] = runWorkflow.mock.calls[0];
    expect(params).toEqual({ partyName: 'The Brave', leaderName: 'Aria' });
  });

  it('cancelling the confirm step aborts the run without calling runWorkflow', () => {
    workflowState = { ...workflowState, selectedTemplateId: 'onboard-party', detail: sampleDetail() };
    render(<WorkflowBrowserView />);

    fireEvent.click(screen.getByTestId('workflow-run-button'));
    fireEvent.click(screen.getByTestId('workflow-run-cancel'));

    expect(runWorkflow).not.toHaveBeenCalled();
    // The confirm prompt is dismissed.
    expect(screen.queryByTestId('workflow-run-confirm')).not.toBeInTheDocument();
  });

  it('Preview steps calls runWorkflow with autoExecute:false WITHOUT a confirm step', () => {
    workflowState = { ...workflowState, selectedTemplateId: 'onboard-party', detail: sampleDetail() };
    render(<WorkflowBrowserView />);

    fireEvent.click(screen.getByTestId('workflow-preview-button'));

    expect(runWorkflow).toHaveBeenCalledTimes(1);
    const [templateId, , opts] = runWorkflow.mock.calls[0];
    expect(templateId).toBe('onboard-party');
    expect(opts).toEqual({ autoExecute: false });
  });

  it('renders run results (executedSteps + failureCount) from lastRun', () => {
    workflowState = {
      ...workflowState,
      selectedTemplateId: 'onboard-party',
      detail: sampleDetail(),
      lastRun: {
        actionType: 'execute_workflow',
        autoExecuted: true,
        executedSteps: 2,
        failureCount: 0,
        steps: [
          { tool: 'create_party', success: true },
          { tool: 'create_character', success: true },
        ],
      },
    };
    render(<WorkflowBrowserView />);
    const panel = screen.getByTestId('workflow-run-result');
    expect(panel).toBeInTheDocument();
    // The executed-steps + failure summary surfaces inside the result panel.
    expect(panel).toHaveTextContent(/Executed steps:\s*2/i);
    expect(panel).toHaveTextContent(/Failures:\s*0/i);
  });

  it('renders an error banner when the store has an error', () => {
    workflowState = { ...workflowState, error: 'Template not found' };
    render(<WorkflowBrowserView />);
    expect(screen.getByText(/Template not found/i)).toBeInTheDocument();
  });

  it('renders a loading state without crashing', () => {
    workflowState = { ...workflowState, isLoading: true, templates: [] };
    expect(() => render(<WorkflowBrowserView />)).not.toThrow();
  });

  it('renders an empty state when there are no templates', () => {
    workflowState = { ...workflowState, templates: [], isLoading: false };
    render(<WorkflowBrowserView />);
    expect(screen.getByTestId('workflow-empty')).toBeInTheDocument();
  });

  it('renders the no-active-character hint when there is no active character', () => {
    gameStateState = { activeCharacterId: null };
    render(<WorkflowBrowserView />);
    // Don't just assert "no crash" — assert the hint element is actually present,
    // so accidentally hiding it would fail the test.
    expect(screen.getByTestId('workflow-no-character')).toBeInTheDocument();
  });

  it('does NOT render stale detail when it mismatches the current selection', () => {
    // The selection moved to seed-world, but the (async) loaded detail still holds
    // onboard-party. The stale detail + its Run actions must NOT render — executing
    // here would run the WRONG template's steps with the wrong params.
    workflowState = {
      ...workflowState,
      selectedTemplateId: 'seed-world',
      detail: sampleDetail(), // detail.template.id === 'onboard-party'
    };
    render(<WorkflowBrowserView />);

    expect(screen.queryByTestId('workflow-detail')).not.toBeInTheDocument();
    expect(screen.queryByText(/create_party/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('workflow-param-partyName')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workflow-run-button')).not.toBeInTheDocument();
  });

  it('renders a dry-run preview result (no executor summary) when autoExecuted is false', () => {
    workflowState = {
      ...workflowState,
      selectedTemplateId: 'onboard-party',
      detail: sampleDetail(),
      lastRun: {
        actionType: 'execute_workflow',
        autoExecuted: false,
        steps: [
          { tool: 'create_party', resolved: true },
          { tool: 'create_character', resolved: true },
        ],
      },
    };
    render(<WorkflowBrowserView />);
    const panel = screen.getByTestId('workflow-run-result');
    expect(panel).toBeInTheDocument();
    // Dry-run heading appears...
    expect(panel).toHaveTextContent(/Preview \(dry-run\)/i);
    // ...but the executed-steps / failures summary is autoExecute-only and must NOT.
    expect(panel).not.toHaveTextContent(/Executed steps:/i);
    expect(panel).not.toHaveTextContent(/Failures:/i);
    // Prepared steps still list.
    expect(panel).toHaveTextContent(/create_party/i);
  });

  it('SAFETY: rapid double Execute clicks fire the destructive run at most once', () => {
    workflowState = { ...workflowState, selectedTemplateId: 'onboard-party', detail: sampleDetail() };
    // Keep the run "in flight" so the in-flight guard stays armed across both clicks.
    runWorkflow.mockReturnValue(new Promise(() => {}));
    render(<WorkflowBrowserView />);

    fireEvent.click(screen.getByTestId('workflow-run-button')); // arm the confirm
    const execBtn = screen.getByTestId('workflow-run-confirm');

    // Two clicks dispatched inside ONE act(): React batches the setConfirmingRun(false)
    // update, so the button is still mounted for the second click. Only a SYNCHRONOUS
    // in-flight guard (a ref) can stop the second click from re-firing the mutating run;
    // a state-based `disabled`/isLoading check cannot, because state hasn't re-rendered.
    act(() => {
      execBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      execBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(runWorkflow).toHaveBeenCalledTimes(1);
  });

  it('drops empty/whitespace-only params and trims the rest before forwarding', () => {
    workflowState = { ...workflowState, selectedTemplateId: 'onboard-party', detail: sampleDetail() };
    render(<WorkflowBrowserView />);

    // Whitespace-only → dropped, so the engine can apply its own default/validation.
    fireEvent.change(screen.getByTestId('workflow-param-partyName'), { target: { value: '   ' } });
    // Surrounding whitespace → trimmed, not forwarded raw.
    fireEvent.change(screen.getByTestId('workflow-param-leaderName'), { target: { value: '  Aria  ' } });

    fireEvent.click(screen.getByTestId('workflow-run-button'));
    fireEvent.click(screen.getByTestId('workflow-run-confirm'));

    const [, params] = runWorkflow.mock.calls[0];
    expect(params).toEqual({ leaderName: 'Aria' });
    expect(params).not.toHaveProperty('partyName');
  });
});
