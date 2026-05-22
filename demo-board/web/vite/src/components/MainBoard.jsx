import React from 'react';
import { AppConfigModal } from './AppConfigModal.jsx';
import { CentrePane } from './CentrePane.jsx';
import { IngestPane } from './IngestPane.jsx';

const ingestFilter = (cardState) => cardState.cardContent?.meta?.ingest === true;

export function MainBoard({ boardId }) {
  return (
    <>
      <AppConfigModal />
      <IngestPane boardId={boardId} includeFilters={[ingestFilter]} layoutStrategy="vertical" />
      <CentrePane boardId={boardId} excludeFilters={[ingestFilter]} layoutStrategy="infinite-canvas" />
    </>
  );
}
