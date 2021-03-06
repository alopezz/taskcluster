let assert = require('assert');
let _ = require('lodash');
let events = require('events');
let taskCreds = require('./task-creds');
const { Task } = require('./data');

/**
 * HintPoller polls for hints for pending tasks.
 *
 * The azure queues don't know if a task is pending they just store hints of
 * pending tasks. To be understood this way:
 *  A) If a task is pending, there is a hint of the task in an azure queue,
 *  B) If there is an hint in an azure queue, it may or may not be pending.
 *
 * It's an if, but not an only-if (think over-approximation).
 */
class HintPoller {
  constructor(parent, taskQueueId) {
    this.parent = parent;
    this.taskQueueId = taskQueueId;
    this.requests = [];
    this.started = false;
    this.destroyed = false;
  }

  requestClaim(count, aborted) {
    assert(!this.destroyed, 'requestClaim() called after destroy()');
    return new Promise((resolve, reject) => {
      // Make a request for count tasks
      let request = { resolve, reject, count };
      this.requests.push(request);

      // Remove request if aborted
      aborted.then(() => {
        // Remove request from requests, but modifying the requests array
        _.pull(this.requests, request);
        // Resolve request empty array
        request.resolve([]);
      }).catch(reject);

      // Start polling
      this.start();
    });
  }

  start() {
    if (!this.started) {
      this.started = true;
      this.poll().catch(err => {
        this.started = false;
        // Resolve everything as failed
        let requests = this.requests;
        this.requests = [];
        this.destroy();
        requests.map(r => r.reject(err));
      }).catch(err => {
        process.nextTick(() => this.parent.emit('error', err));
      });
    }
  }

  async poll() {
    // Get poll functions for pending queues (ordered by priority)
    let polls = await this.parent._queueService.pendingQueues(
      this.taskQueueId,
    );
    // While we have requests for hints
    while (_.sumBy(this.requests, 'count') > 0) {
      let claimed = 0;
      let released = 0;

      // In-order of priority, we poll hints from queues
      for (let poll of polls) {
        // While limit of hints requested is greater zero, and we are getting
        // hints from the queue we continue to claim from this queue
        let limit, hints;
        let i = 10; // count iterations a limit to 10, before we start over
        while ((limit = _.sumBy(this.requests, 'count')) > 0 &&
               (hints = await poll(limit)).length > 0 && i-- > 0) {
          // Count hints claimed
          claimed += hints.length;

          // While we have hints and requests for hints we resolve requests
          while (hints.length > 0 && this.requests.length > 0) {
            let { resolve, count } = this.requests.shift();
            resolve(hints.splice(0, count));
          }

          // Release remaining hints (this shouldn't happen often!)
          await Promise.all(hints.map(hint => hint.release()));
          released += hints.length;
        }
      }

      // If nothing was claimed, we sleep 1000ms before polling again
      let slept = false;
      if (claimed === 0) {
        slept = true;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      this.parent._monitor.log.hintPoller({
        claimed,
        released,
        slept,
      });
    }

    // No more requests, let's clean-up
    this.destroy();
  }

  destroy() {
    // Remove entry from parent
    this.destroyed = true;
    delete this.parent._hintPollers[this.taskQueueId];
    assert(_.sumBy(this.requests, 'count') === 0,
      'destroying while we have pending requests is not allowed');
  }
}

/** WorkClaimer manages to claim work from azure queues. */
class WorkClaimer extends events.EventEmitter {
  /**
   * Create a new WorkClaimer.
   *
   * options:
   * {
   *   publisher:     // Pulse publisher from exchanges.js
   *   db:            // Database object
   *   queueService:  // queueService from queueservice.js
   *   monitor:       // monitor object from taskcluster-lib-monitor
   *   claimTimeout:  // Time for a claim to timeout in seconds
   *   credentials:   // Taskcluster credentials for creating temp creds.
   * }
   */
  constructor(options) {
    assert(options);
    assert(options.publisher);
    assert(options.db);
    assert(options.queueService);
    assert(options.monitor);
    assert(typeof options.claimTimeout === 'number');
    assert(options.credentials);
    super();
    this._monitor = options.monitor;
    this._publisher = options.publisher;
    this.db = options.db;
    this._queueService = options.queueService;
    this._claimTimeout = options.claimTimeout;
    this._credentials = options.credentials;
    this._hintPollers = {}; // provisionerId/workerType -> HintPoller
  }

  async claim(taskQueueId, workerGroup, workerId, count, aborted) {
    let claims = [];
    let done = false;
    aborted.then(() => done = true);
    // As soon as we have claims we return so work can get started.
    // We don't try to claim up to the count, that could take time and we risk
    // dropping the claims in case of server crash.
    while (claims.length === 0 && !done) {
      // Get a HintPoller
      let key = taskQueueId;
      let hintPoller = this._hintPollers[key];
      if (!hintPoller) {
        this._hintPollers[key] = hintPoller = new HintPoller(this, taskQueueId);
      }

      // Poll for hints (azure messages saying a task may be pending)
      let hints = await hintPoller.requestClaim(count, aborted);

      // Try to claim all the hints
      claims = await Promise.all(hints.map(async (hint) => {
        try {
          // Try to claim task from hint
          let result = await this._monitor.timer('claimTask', this.claimTask(
            hint.taskId, hint.runId, workerGroup, workerId, null, hint.hintId,
          ));
          // Remove hint, if successfully used (don't block)
          hint.remove().catch(err => {
            this._monitor.reportError(err, 'warning', {
              comment: 'hint.remove() -- error ignored',
            });
          });
          // Return result
          return result;
        } catch (err) {
          // Report error, don't block
          this._monitor.reportError(err, {
            comment: 'claimTask from hint failed',
          });
          // Release hint (so it becomes visible again)
          hint.release().catch(err => {
            this._monitor.reportError(err, 'warning', {
              comment: 'hint.release() -- error ignored',
            });
          });
        }
        return 'error-claiming';
      }));

      // Remove entries from claims resolved as string (which indicates error)
      claims = claims.filter(claim => typeof claim !== 'string');
    }
    return claims;
  }

  /**
   * Claim a taskId/runId, returns 'conflict' if already claimed, and
   * 'task-not-found' or 'task-not-found' if not found.
   * If claim works out this returns a claim structure.
   */
  async claimTask(taskId, runId, workerGroup, workerId, task = null, hintId = null) {
    // Load task, if not given
    if (!task) {
      task = await Task.get(this.db, taskId);
      if (!task) {
        return 'task-not-found';
      }
    }

    // Set takenUntil to now + claimTimeout, rounding up to the nearest second
    // since we compare these times for equality after sending them to Azure
    // and toJSON()
    let takenUntil = new Date();
    takenUntil.setSeconds(Math.ceil(takenUntil.getSeconds() + this._claimTimeout));

    // put the claim-expiration message into the queue first.  If the
    // subsequent claim_task fails, the claim-expiration message will be
    // ignored when it appears.
    await this._queueService.putClaimMessage(taskId, runId, takenUntil);
    task.updateStatusWith(
      await this.db.fns.claim_task(taskId, runId, workerGroup, workerId, hintId, takenUntil));

    // Find run that we (may) have modified
    let run = task.runs[runId];
    if (!run) {
      return 'run-not-found';
    }

    // If the run wasn't claimed by this workerGroup/workerId, then we return
    // 'conflict' as it must have claimed by someone else
    if (task.runs.length - 1 !== runId ||
        run.state !== 'running' ||
        run.workerGroup !== workerGroup ||
        run.workerId !== workerId ||
        run.hintId !== hintId) {
      return 'conflict';
    }

    // Construct status object
    let status = task.status();

    // Publish task running message, it's important that we publish even if this
    // is a retry request and we didn't make any changes in task.modify
    await this._publisher.taskRunning({
      status: status,
      runId: runId,
      workerGroup: workerGroup,
      workerId: workerId,
      takenUntil: run.takenUntil,
    }, task.routes);
    this._monitor.log.taskRunning({ taskId, runId });

    let credentials = taskCreds(
      taskId,
      runId,
      workerGroup,
      workerId,
      takenUntil,
      task.scopes,
      this._credentials,
    );

    // Return claim structure
    return {
      status: status,
      runId: runId,
      workerGroup: workerGroup,
      workerId: workerId,
      takenUntil: run.takenUntil,
      task: await task.definition(),
      credentials: credentials,
    };
  }
}

// Export WorkClaimer
module.exports = WorkClaimer;
