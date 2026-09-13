// Single render entry point that composes the individual view renderers.

import { state } from './store.js';
import { renderShell, renderUser, setActiveView } from './shell.js';
import { renderSourceControls, renderInbox } from './inbox.js';
import { renderProjects } from './projects.js';
import { renderInsights } from './insights.js';

export function render() {
  renderUser();
  renderShell();
  renderSourceControls();
  renderInbox();
  renderProjects();
  renderInsights();
  setActiveView(state.activeView);
}
