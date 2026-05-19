import React from 'react';
import { CentrePane } from './CentrePane.jsx';
import { IngestPane } from './IngestPane.jsx';

const ingestFilter = (cardState) => cardState.cardContent?.meta?.ingest === true;

export function MainBoard({ boardId }) {
  return (
    <>
      <IngestPane boardId={boardId} includeFilters={[ingestFilter]} layoutStrategy="vertical" />
      <CentrePane boardId={boardId} excludeFilters={[ingestFilter]} layoutStrategy="infinite-canvas" />
    </>
  );
}
