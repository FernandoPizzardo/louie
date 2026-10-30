import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * AI disclosure. Shown from the "AI-generated" badge in the header and on first
 * run. Louie is built almost entirely by an AI coding agent, which shapes what
 * you should expect from it: it is not a product with a support contract, and
 * the confident-looking parts may still be wrong.
 */
export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" /> About Louie
          </DialogTitle>
          <DialogDescription>
            An HTTP/HTTPS intercepting proxy debugger in the spirit of Charles Proxy.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="font-medium text-amber-700 dark:text-amber-400">
              This is an AI-generated application.
            </p>
            <p className="mt-1 text-muted-foreground">
              Louie was written almost entirely by an AI coding agent, directed and
              reviewed by a human. Treat it accordingly:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>It may contain bugs a human would have caught.</li>
              <li>There is no support contract, warranty, or SLA.</li>
              <li>It is for your own debugging, not for production or regulated traffic.</li>
            </ul>
          </div>

          <p className="text-muted-foreground">
            Louie decrypts HTTPS by acting as a man-in-the-middle with its own root
            certificate. Only use it on traffic and devices you own or are
            authorised to inspect. The CA private key never leaves your machine and
            is never served over the network.
          </p>

          <p className="text-muted-foreground">
            MIT licensed. Source and issues:{' '}
            <a
              className="underline underline-offset-2"
              href="https://github.com/FernandoPizzardo/louie"
              target="_blank"
              rel="noreferrer"
            >
              github.com/FernandoPizzardo/louie
            </a>
          </p>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
