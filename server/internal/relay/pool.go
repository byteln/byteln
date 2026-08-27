package relay

// Worker is a bounded goroutine pool for accept/upgrade/frame handling.
type Worker struct {
	sem chan struct{}
}

func NewWorker(size int) *Worker {
	if size < 1 {
		size = 1
	}
	return &Worker{sem: make(chan struct{}, size)}
}

// TryGo runs fn in a worker if a slot is free within waitCh readiness.
// Returns false if the pool is saturated (caller should reject).
func (w *Worker) TryGo(fn func()) bool {
	select {
	case w.sem <- struct{}{}:
		go func() {
			defer func() { <-w.sem }()
			fn()
		}()
		return true
	default:
		return false
	}
}

func (w *Worker) Go(fn func()) {
	w.sem <- struct{}{}
	go func() {
		defer func() { <-w.sem }()
		fn()
	}()
}
