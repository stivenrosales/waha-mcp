/**
 * Calls `release` once the response body has been fully read, has failed, or was cancelled (a
 * client that disconnects), or right away when there is no body. Used to hold a tenant runtime
 * for as long as a streamed response (SSE, media) still reads from it.
 */
export function releaseWhenDone(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    release();
  };
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
