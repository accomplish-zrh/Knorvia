//! The existing control reader is the only chat FIFO consumer. No model work
//! or admission runs on a ticker or renderer; normal native execution owns it.
use super::*;
use knorvia_store::{MessageQueue, QueuedMessage};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Default)]
pub(super) struct QueueDriver { last_poll: Option<Instant>, cursor: usize, pub(super) admitting: bool }

fn provider_stamp() -> String {
    let mut hash = Sha256::new();
    for key in ["KNORVIA_PROVIDER_PROFILE_ID", "KNORVIA_PROVIDER_MODEL", "KNORVIA_PROVIDER_BASE_URL", "KNORVIA_PROVIDER_API_KEY", "KNORVIA_PROVIDER_PROTOCOL", "KNORVIA_PROVIDER_UPSTREAM_PROTOCOL"] {
        hash.update(key.as_bytes()); hash.update([0]);
        hash.update(std::env::var(key).unwrap_or_default().as_bytes()); hash.update([0]);
    }
    format!("{:x}", hash.finalize())
}

fn queue_error(message: &str) -> ProtocolError { ProtocolError::new(ErrorCategory::Conflict, message) }

impl ControlPlane {
    pub(super) fn ensure_message_queue_order(&self,thread_id:&str)->Result<(),ProtocolError>{
        if !self.queue_driver.admitting && self.store.read_message_queue(thread_id).map_err(|e|e.into_protocol())?.has_pending(){return Err(queue_error("This task has queued messages. Add to its queue or use immediate instructions on its active turn."));}Ok(())
    }
    pub(super) fn rpc_message_queue(&mut self, method: &str, params: &Value) -> Result<Value, ProtocolError> {
        let thread_id = required_str(params, "threadId")?;
        let thread = self.store.read_thread(thread_id).map_err(|e| e.into_protocol())?;
        if method == "turnQueue/read" { return serde_json::to_value(self.store.read_message_queue(thread_id).map_err(|e|e.into_protocol())?).map_err(json_err); }
        if method == "turnQueue/enqueue" {
            self.ensure_accepting_work()?;
            if thread.status == "archived" { return Err(queue_error("unarchive this task before queueing messages")); }
            self.ensure_workspace_runnable(&thread.workspace_id)?;
            let id = required_str(params,"requestId")?;
            if params.get("idempotencyKey").and_then(Value::as_str) != Some(format!("{id}-enqueue").as_str()) {
                return Err(ProtocolError::new(ErrorCategory::InvalidArgument,"enqueue requires its stable requestId-enqueue idempotencyKey"));
            }
            let input = required_str(params,"input")?;
            let mut options = params.get("options").cloned().unwrap_or_else(||json!({}));
            let object=options.as_object_mut().ok_or_else(||ProtocolError::new(ErrorCategory::InvalidArgument,"queue options must be an object"))?;
            for key in object.keys() {
                if !matches!(key.as_str(),"model"|"reasoningEffort"|"cwd"|"write"|"providerId") { return Err(ProtocolError::new(ErrorCategory::InvalidArgument,format!("unknown queue option {key}"))); }
            }
            if object.get("write").is_some_and(|v|!v.is_boolean()) { return Err(ProtocolError::new(ErrorCategory::InvalidArgument,"write must be boolean")); }
            for key in ["model","reasoningEffort","cwd","providerId"] {
                if object.get(key).is_some_and(|v|!v.is_string()&&!v.is_null()) { return Err(ProtocolError::new(ErrorCategory::InvalidArgument,format!("{key} must be text or null"))); }
            }
            // Resolve omitted defaults NOW, never against mutable settings at dequeue.
            let selected=self.executor_lock().thread_settings(thread_id)?.unwrap_or_default();
            let resolved=selected.merge(&turns::settings_from_params(&options,None)?);
            options["cwd"]=json!(resolved.cwd.or(self.store.read_workspace_cwd(&thread.workspace_id).map_err(|e|e.into_protocol())?).or_else(||std::env::current_dir().ok().map(|p|p.to_string_lossy().into_owned())));
            options["model"]=json!(resolved.model.or_else(||std::env::var("KNORVIA_PROVIDER_MODEL").ok()));
            options["reasoningEffort"]=json!(resolved.reasoning_effort);
            options["write"]=json!(options.get("write").and_then(Value::as_bool).unwrap_or(false));
            let activity=self.store.read_thread_activity(thread_id).map_err(|e|e.into_protocol())?;
            let after=activity.active_turn.or(activity.last_turn).map(|t|t.id);
            let execution=after.as_deref().map(|id|self.store.find_goal_execution_by_turn(id)).transpose().map_err(|e|e.into_protocol())?.flatten().map(|run|run.id);
            let fingerprint=format!("{:x}",Sha256::digest(serde_json::to_vec(&json!({"input":input,"options":params.get("options"),"threadId":thread_id})).map_err(json_err)?));
            let item=QueuedMessage { id:id.into(),sequence:0,request_fingerprint:fingerprint,input:input.into(),options,provider_stamp:provider_stamp(),status:"queued".into(),created_at:format!("{}ms",SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()),turn_id:None,execution_id:None,dispatch_method:None,dispatch_params:None,error:None };
            return serde_json::to_value(self.store.enqueue_message(thread_id,item,after,execution).map_err(|e|e.into_protocol())?).map_err(json_err);
        }
        let revision=params.get("revision").and_then(Value::as_u64).ok_or_else(||ProtocolError::new(ErrorCategory::InvalidArgument,"queue revision is required"))?;
        let message_id=params.get("messageId").and_then(Value::as_str);
        if method=="turnQueue/resume" {
            self.ensure_accepting_work()?;
            if let Some(id)=thread.goal_id.as_deref() {
                if self.store.read_goal(id).map_err(|e|e.into_protocol())?.status!="active" { return Err(queue_error("resume the Goal explicitly before continuing its queue")); }
            }
        }
        let activity=self.store.read_thread_activity(thread_id).map_err(|e|e.into_protocol())?;
        let active=activity.active_turn.map(|t|t.id);
        let acknowledged=activity.last_turn.map(|t|t.id);
        let queue=self.store.update_message_queue(thread_id,Some(revision),|queue|{
            match method {
                "turnQueue/cancel"=>{
                    let item=queue.items.iter_mut().find(|i|Some(i.id.as_str())==message_id).ok_or_else(||knorvia_store::StoreError::from(queue_error("queued message was not found")))?;
                    if item.status=="cancelled" { return Ok(()); }
                    if item.status!="queued" { return Err(queue_error("message admission already began; cancellation cannot retract it").into()); }
                    item.status="cancelled".into();
                },
                "turnQueue/pause"=>{queue.paused=true;queue.reason=Some("Paused by you. Continue when ready.".into());},
                "turnQueue/resume"=>{
                    queue.paused=false;queue.reason=None;
                    // Explicit acknowledgement of a prior failed/interrupted
                    // predecessor does not resurrect that turn or Goal run.
                    if !queue.items.iter().any(|i|matches!(i.status.as_str(),"dispatching"|"needs_check")) { queue.after_turn_id=active;queue.after_execution_id=None;queue.acknowledged_turn_id=acknowledged; }
                },
                _=>return Err(ProtocolError::new(ErrorCategory::InvalidArgument,"unknown queue operation").into()),
            }
            Ok(())
        }).map_err(|e|e.into_protocol())?;
        serde_json::to_value(queue).map_err(json_err)
    }

    /// Stop is serialized with dequeue by this same control owner. The pause
    /// reaches WAL before any interrupt can let the previous turn finish.
    pub(super) fn pause_message_queue_for_stop(&self,thread_id:&str)->Result<(),ProtocolError>{
        let queue=self.store.read_message_queue(thread_id).map_err(|e|e.into_protocol())?;
        if queue.has_pending() {self.store.update_message_queue(thread_id,None,|q|{q.paused=true;q.reason=Some("Task stopped; queued messages are kept. Continue explicitly.".into());Ok(())}).map_err(|e|e.into_protocol())?;}
        Ok(())
    }

    /// Call from both stdio and shared daemon owner loops. At most four small
    /// queues per 250ms, at most one admission for each; no background writer.
    pub fn dispatch_queued_messages(&mut self)->Result<usize,ProtocolError>{
        // Durable queue intents were already admitted by an initialized client.
        // The shared owner has no client handshake between requests and must
        // keep dispatching after that client detaches.
        if self.admissions_paused.load(std::sync::atomic::Ordering::Acquire){return Ok(0);}
        if self.queue_driver.last_poll.is_some_and(|last|last.elapsed()<Duration::from_millis(250)){return Ok(0);}
        self.queue_driver.last_poll=Some(Instant::now());
        let ids=self.store.message_queue_thread_ids().map_err(|e|e.into_protocol())?;
        if ids.is_empty(){return Ok(0);}
        let mut count=0;
        for _ in 0..ids.len().min(4){
            let id=&ids[self.queue_driver.cursor%ids.len()];self.queue_driver.cursor=(self.queue_driver.cursor+1)%ids.len();
            if self.dispatch_thread_queue(id)?{count+=1;}
        }
        Ok(count)
    }

    fn pause_queue_reason(&self,queue:&MessageQueue,reason:&str)->Result<(),ProtocolError>{
        self.store.update_message_queue(&queue.thread_id,Some(queue.revision),|q|{q.paused=true;q.reason=Some(reason.into());Ok(())}).map_err(|e|e.into_protocol())?;Ok(())
    }

    pub fn has_queued_message_work(&self) -> Result<bool, ProtocolError> {
        if self.admissions_paused.load(std::sync::atomic::Ordering::Acquire) { return Ok(false); }
        for id in self.store.message_queue_thread_ids().map_err(|e|e.into_protocol())? {
            let queue = self.store.read_message_queue(&id).map_err(|e|e.into_protocol())?;
            if !queue.paused && queue.has_pending() { return Ok(true); }
        }
        Ok(false)
    }

    fn dispatch_thread_queue(&mut self,thread_id:&str)->Result<bool,ProtocolError>{
        let queue=self.store.read_message_queue(thread_id).map_err(|e|e.into_protocol())?;
        if queue.paused{return Ok(false);}
        let Some(item)=queue.items.iter().find(|i|matches!(i.status.as_str(),"queued"|"dispatching"|"needs_check")).cloned() else{return Ok(false);};
        let thread=self.store.read_thread(thread_id).map_err(|e|e.into_protocol())?;
        if thread.status=="archived"{self.pause_queue_reason(&queue,"Task archived; the queue is kept.")?;return Ok(false);}
        if self.ensure_workspace_runnable(&thread.workspace_id).is_err(){self.pause_queue_reason(&queue,"Project is not available; the queue is kept.")?;return Ok(false);}
        if item.provider_stamp!=provider_stamp(){self.pause_queue_reason(&queue,"The configured model account changed. Restore the original connection or cancel and submit again.")?;return Ok(false);}
        // A replay must use immutable admission params even if its accepted
        // turn is still running or the Goal was later paused.
        let (method,params)=if let (Some(method),Some(params))=(item.dispatch_method.clone(),item.dispatch_params.clone()){(method,params)}else{
            let activity=self.store.read_thread_activity(thread_id).map_err(|e|e.into_protocol())?;
            if activity.active_turn.is_some(){return Ok(false);}
            if let Some(execution_id)=queue.after_execution_id.as_deref(){
                let run=self.store.read_goal_execution(execution_id).map_err(|e|e.into_protocol())?;
                if matches!(run.status.as_str(),"running"|"waitingUser"){return Ok(false);}
                if run.status!="completed"{self.pause_queue_reason(&queue,"The Goal run did not complete normally; queued messages are paused.")?;return Ok(false);}
            }
            if let Some(turn_id)=queue.after_turn_id.as_deref(){
                let turn=self.store.read_turn(turn_id).map_err(|e|e.into_protocol())?;
                if turn.status=="running"{return Ok(false);}
                if turn.status!="completed"{self.pause_queue_reason(&queue,"The previous turn failed or stopped; queued messages are paused.")?;return Ok(false);}
            }
            if let Some(latest)=activity.last_turn.as_ref(){
                // A different window may have started another ordinary turn.
                if queue.after_turn_id.as_deref()!=Some(latest.id.as_str())&&queue.acknowledged_turn_id.as_deref()!=Some(latest.id.as_str())&&latest.status!="completed"{self.pause_queue_reason(&queue,"Another turn stopped without normal completion; continue the queue explicitly.")?;return Ok(false);}
                if thread.goal_id.is_some(){
                    if let Some(run)=self.store.find_goal_execution_by_turn(&latest.id).map_err(|e|e.into_protocol())?{
                        if matches!(run.status.as_str(),"running"|"waitingUser"){return Ok(false);}
                        if run.status!="completed"&&queue.acknowledged_turn_id.as_deref()!=Some(latest.id.as_str()){self.pause_queue_reason(&queue,"Waiting for explicit continuation after the Goal run stopped.")?;return Ok(false);}
                    }
                }
            }
            let mut params=json!({"threadId":thread_id,"input":item.input,"tools":{"write":item.options.get("write").and_then(Value::as_bool).unwrap_or(false)},"idempotencyKey":format!("{}-queued-turn",item.id)});
            for key in ["model","reasoningEffort","cwd"]{if let Some(value)=item.options.get(key){params[key]=value.clone();}}
            let method=if let Some(goal_id)=thread.goal_id.as_deref(){
                let goal=self.store.read_goal(goal_id).map_err(|e|e.into_protocol())?;
                if goal.status!="active"{self.pause_queue_reason(&queue,"Goal paused or ended; the queue will not resume it.")?;return Ok(false);}
                params["id"]=json!(goal_id);params["revision"]=json!(goal.revision);params["requestKey"]=json!(format!("{}-queued-goal-run",item.id));"goal/run"
            }else{"turn/start"};
            self.store.update_message_queue(thread_id,Some(queue.revision),|q|{
                let row=q.items.iter_mut().find(|i|i.id==item.id).ok_or_else(||knorvia_store::StoreError::from(queue_error("queue item disappeared")))?;
                if row.status!="queued"{return Err(queue_error("queue admission changed").into());}
                row.status="dispatching".into();row.dispatch_method=Some(method.into());row.dispatch_params=Some(params.clone());Ok(())
            }).map_err(|e|e.into_protocol())?;
            (method.to_string(),params)
        };
        let request=RpcRequest{jsonrpc:JSONRPC_VERSION.into(),id:knorvia_protocol::RequestId::String(format!("queue-{}",item.id)),method,params};
        self.queue_driver.admitting=true;
        let outcome=self.handle_request(&request);
        self.queue_driver.admitting=false;
        self.store.update_message_queue(thread_id,None,|q|{
            let row=q.items.iter_mut().find(|i|i.id==item.id).ok_or_else(||knorvia_store::StoreError::from(queue_error("queue item disappeared")))?;
            match &outcome{
                Ok(result)=>{
                    let turn_id=result.pointer("/turn/id").and_then(Value::as_str).or_else(||result.pointer("/execution/rounds/0/turnId").and_then(Value::as_str));
                    if let Some(turn_id)=turn_id{
                        row.status="delivered".into();row.turn_id=Some(turn_id.into());row.execution_id=result.pointer("/execution/id").and_then(Value::as_str).map(str::to_string);row.error=None;
                        q.after_turn_id=row.turn_id.clone();q.after_execution_id=row.execution_id.clone();
                    }else{row.status="needs_check".into();row.error=Some("Native admission returned no durable turn identity".into());q.paused=true;q.reason=row.error.clone();}
                },
                Err(error)=>{row.status="needs_check".into();row.error=Some(error.message.clone());q.paused=true;q.reason=Some("Delivery needs confirmation. The original message identity is retained; later messages are paused.".into());},
            }Ok(())
        }).map_err(|e|e.into_protocol())?;
        Ok(true)
    }
}
