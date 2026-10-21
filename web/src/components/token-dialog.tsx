import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Props {
  open: boolean
  onSubmit: (token: string) => void
}

/** Shown when the engine answers 401: the control API was started with --token. */
export function TokenDialog({ open, onSubmit }: Props) {
  const [value, setValue] = useState('')

  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Engine token required</DialogTitle>
          <DialogDescription>
            This engine was started with a control token. Enter it to connect.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (value.trim()) onSubmit(value.trim())
          }}
        >
          <Label htmlFor="token">Token</Label>
          <Input
            id="token"
            type="password"
            autoComplete="off"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <DialogFooter>
            <Button type="submit" disabled={!value.trim()}>Connect</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
