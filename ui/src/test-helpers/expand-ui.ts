import { cloneElement, isValidElement, type ReactNode } from 'react';

const pureWrapperNames = new Set([
  'TasksScreen',
  'NewTaskScreen',
  'TaskDetailScreen',
  'SetupScreen',
  'IntroScreen',
  'AppLayout',
  'AppFeedback',
  'TaskConfirmation',
  'ProjectSetup',
  'SetupPrices',
  'TaskDraftFields',
  'NewTaskOptions',
  'TaskSummary',
  'TaskConnection',
  'TaskOutcome',
  'TaskOutcomeActions',
  'TaskOutcomeMenu',
  'TaskCriteria',
  'TaskDetails',
  'TaskMeasurement',
  'TaskCost',
  'GuidedApplicationMode',
  'GuidedCandidate',
  'GuidedComparison',
  'GuidedBundle',
  'GuidedPolicy',
  'GuidedReview',
  'GuidedAdvanced',
  'GuidedMeasurementRequest'
]);

function isPureWrapper(type: unknown): type is (props: unknown) => ReactNode {
  return typeof type === 'function' && pureWrapperNames.has(type.name);
}

export function expandUi(node: ReactNode): ReactNode {
  if (Array.isArray(node)) {
    const children = node.map((child: ReactNode) => expandUi(child));
    return children.every((child, index) => child === node[index]) ? node : children;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (isPureWrapper(node.type)) return expandUi(node.type(node.props));
  // Existing leaves retain their types, keys and callbacks for identity assertions.
  const children = expandUi(node.props.children);
  return children === node.props.children ? node : cloneElement(node, { children });
}
