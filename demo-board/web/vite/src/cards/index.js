import { IdentityCard } from './IdentityCard.jsx';
import { IncomeCard }   from './IncomeCard.jsx';

/**
 * Map card id → body component.
 * MainBoard falls back to a raw JSON view for unregistered cards.
 */
export const CARD_RENDERERS = {
  'card-my-identity':           IdentityCard,
  'card-finbook-latest-income': IncomeCard,
};
