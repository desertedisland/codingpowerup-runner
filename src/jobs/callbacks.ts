// The runner's side of the mid-turn callbacks: the one function the dispatcher provides (send a
// CALLBACK frame, await its CALLBACK_RESULT) unfolded into the handler objects the agent's tool
// server expects, and the Build-mode question the Explore mode guard asks before every edit.
import { IExploreToolHandlers, IPlanToolHandlers, TRunnerCallbackName } from '@yellowmelon/factory-global-types';

export type TCallbackHandler = (name: TRunnerCallbackName, payload: unknown) => Promise<string>;

export interface ITurnHandlers {
  planTools?: IPlanToolHandlers;
  exploreTools?: IExploreToolHandlers;
}

export const handlersFromCallback = (onCallback: TCallbackHandler, turnKind: string): ITurnHandlers => {

  if (turnKind === 'planning') {
    return {
      planTools: {
        updatePlan: (update) => onCallback('plan.update', update),
        upsertItem: (item) => onCallback('plan.upsertItem', item),
        removeItem: (itemId) => onCallback('plan.removeItem', itemId),
      },
    };
  }

  if (turnKind === 'explore') {
    return {
      exploreTools: {
        classify: (capture) => onCallback('explore.classify', capture),
        proposeBreakdown: (capture) => onCallback('explore.proposeBreakdown', capture),
        reportSandbox: (capture) => onCallback('explore.reportSandbox', capture),
        draftItem: (capture) => onCallback('explore.draftItem', capture),
      },
    };
  }

  return {};

};

export const canBuildFromCallback = (onCallback: TCallbackHandler): (() => Promise<boolean>) => async () => (await onCallback('explore.canBuild', {})) === 'true';
