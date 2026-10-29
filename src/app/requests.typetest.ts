// Compile-time only (npm run typecheck; not exported, not bundled): request attachments and delete are public types.
import type { ListingRequest, NewRequest, NewRequestAttachment, RequestAttachment, RequestBlock } from './index';
import type { Requests } from './requests';

export const photo: NewRequestAttachment = { name: 'wall.jpg', contentType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,/9j/' };
export const bare: NewRequestAttachment = { dataUrl: 'data:image/png;base64,iVBORw==' };
export const ask: NewRequest<{ design: string }> = {
  listingId: 'l1', kind: 'quote', title: 'Shelf', message: 'Could you build this?', payload: { design: 'd1' }, attachments: [photo, bare],
};
export const read: RequestAttachment = { name: 'wall.jpg', contentType: 'image/jpeg', size: 3, dataUrl: photo.dataUrl };
export const seen: Pick<ListingRequest, 'attachments'> = { attachments: [read] };
export const listed: Pick<ListingRequest, 'attachments'> = {};

// delete resolves with nothing.
export async function remove(requests: Requests, id: string): Promise<void> {
  const nothing: void = await requests.delete(id);
  return nothing;
}

export const block: RequestBlock = { id: 'b1', name: null, blockedAt: '2026-10-27T00:00:00Z' };

// @ts-expect-error - an attachment needs its dataUrl.
export const noUrl: NewRequestAttachment = { name: 'x.jpg' };
