import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { BreakpointHit } from '@/lib/types'

interface Props {
  hit: BreakpointHit | null
  onClose: () => void
  onContinue: (id: number) => void
  onAbort: (id: number) => void
  onEdit: (id: number, request: unknown, response: unknown) => void
}

export function BreakpointDialog({ hit, onClose, onContinue, onAbort, onEdit }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [reqMethod, setReqMethod] = useState('')
  const [reqUrl, setReqUrl] = useState('')
  const [reqHeaders, setReqHeaders] = useState('')
  const [reqBody, setReqBody] = useState('')
  const [resStatus, setResStatus] = useState('')
  const [resHeaders, setResHeaders] = useState('')
  const [resBody, setResBody] = useState('')

  const isReq = hit?.phase === 'request'
  const isRes = hit?.phase === 'response'

  const buildRequest = () => {
    if (!hit || !isReq) return undefined
    const headers: Record<string, string> = {}
    try {
      if (reqHeaders.trim()) Object.assign(headers, JSON.parse(reqHeaders))
    } catch {
      setError('Request headers must be valid JSON')
      return null
    }
    if (hit.request.body.editable === false) {
      setError('Binary request bodies cannot be edited')
      return null
    }
    return {
      method: reqMethod,
      url: reqUrl,
      headers,
      body: { type: 'text' as const, text: reqBody },
    }
  }

  const buildResponse = () => {
    if (!hit || !isRes) return undefined
    const headers: Record<string, string> = {}
    try {
      if (resHeaders.trim()) Object.assign(headers, JSON.parse(resHeaders))
    } catch {
      setError('Response headers must be valid JSON')
      return null
    }
    if (hit.response.body.editable === false) {
      setError('Binary response bodies cannot be edited')
      return null
    }
    const status = parseInt(resStatus, 10)
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      setError('Response status must be an integer between 100 and 599')
      return null
    }
    return {
      status,
      headers,
      body: { type: 'text' as const, text: resBody },
    }
  }

  const handleEdit = () => {
    if (!hit) return
    setError(null)
    const edit = isReq ? buildRequest() : buildResponse()
    if (!edit) return
    onEdit(hit.id, isReq ? edit : undefined, isRes ? edit : undefined)
  }

  if (!hit) return null

  return (
    <Dialog open={!!hit} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Badge variant="outline">{hit.phase}</Badge>
            Breakpoint #{hit.id} — Transaction #{hit.transactionId}
          </DialogTitle>
          <DialogDescription>Transaction is paused for inspection.</DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Tabs defaultValue={isReq ? 'request' : 'response'}>
          <TabsList>
            <TabsTrigger value="request">Request</TabsTrigger>
            <TabsTrigger value="response">Response</TabsTrigger>
          </TabsList>

          <TabsContent value="request" className="space-y-3">
            <div className="grid grid-cols-[auto_1fr] items-center gap-2">
              <Label className="text-xs">Method</Label>
              <Input
                size={1}
                className="font-mono text-sm"
                defaultValue={hit.request.method}
                onChange={(e) => setReqMethod(e.target.value)}
              />
              <Label className="text-xs">URL</Label>
              <Input
                size={1}
                className="font-mono text-sm"
                defaultValue={hit.request.url}
                onChange={(e) => setReqUrl(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Headers (JSON)</Label>
              <textarea
                className="mt-1 h-24 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                defaultValue={JSON.stringify(hit.request.headers, null, 2)}
                onChange={(e) => setReqHeaders(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Body</Label>
              <ScrollArea className="mt-1 h-40 rounded-md border">
                <textarea
                  className="h-full w-full bg-background px-3 py-2 font-mono text-xs"
                  defaultValue={hit.request.body.text}
                  onChange={(e) => setReqBody(e.target.value)}
                  readOnly={!hit.request.body.editable && hit.request.body.type === 'binary'}
                />
              </ScrollArea>
              {hit.request.body.type === 'binary' && (
                <p className="mt-1 text-xs text-muted-foreground">Binary body — editing disabled</p>
              )}
            </div>
          </TabsContent>

          <TabsContent value="response" className="space-y-3">
            <div className="grid grid-cols-[auto_1fr] items-center gap-2">
              <Label className="text-xs">Status</Label>
              <Input
                size={1}
                className="font-mono text-sm"
                defaultValue={String(hit.response.status)}
                onChange={(e) => setResStatus(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Headers (JSON)</Label>
              <textarea
                className="mt-1 h-24 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                defaultValue={JSON.stringify(hit.response.headers, null, 2)}
                onChange={(e) => setResHeaders(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Body</Label>
              <ScrollArea className="mt-1 h-40 rounded-md border">
                <textarea
                  className="h-full w-full bg-background px-3 py-2 font-mono text-xs"
                  defaultValue={hit.response.body.text}
                  onChange={(e) => setResBody(e.target.value)}
                  readOnly={!hit.response.body.editable && hit.response.body.type === 'binary'}
                />
              </ScrollArea>
              {hit.response.body.type === 'binary' && (
                <p className="mt-1 text-xs text-muted-foreground">Binary body — editing disabled</p>
              )}
            </div>
          </TabsContent>
        </Tabs>

        <Separator />

        <DialogFooter className="gap-2">
          <div className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{hit.request.method}</span>
            <span className="truncate max-w-[200px]">{hit.request.url}</span>
          </div>
          <Button variant="outline" onClick={() => onAbort(hit.id)}>
            Abort
          </Button>
          <Button variant="outline" onClick={() => onContinue(hit.id)}>
            Continue
          </Button>
          <Button onClick={handleEdit}>Edit & Continue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
