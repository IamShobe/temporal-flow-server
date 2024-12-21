import {Activity, ChronologicalItem, Event, EventType, HistoryResponse, ParseOptions, Workflow} from "./domain";


export class TemporalWorkflowChronologicalItems {
    rootWorkflow: ChronologicalItem[]
    childWorkflows: Record<string, ChronologicalItem[]>

    constructor(rootWorkflow: ChronologicalItem[], childWorkflows: Record<string, ChronologicalItem[]>) {
        this.rootWorkflow = rootWorkflow;
        this.childWorkflows = childWorkflows;
    }
}

export default class TemporalService {

    apiKey: string
    endpoint: string

    constructor() {
        this.apiKey = process.env.TEMPORAL_API_KEY ?? ""
        this.endpoint = process.env.TEMPORAL_ENDPOINT ?? ""

        if (!this.apiKey) {
            throw new Error("Temporal API Key is required")
        }

        if (!this.endpoint) {
            throw new Error("Temporal Endpoint is required")
        }
    }

    async getRootWorkflowData(namespace: string, rootWorkflowId: string) {
        const historyResponse = await this.getWorkflowData(namespace, rootWorkflowId);

        const childWorkflowsMap: Record<string, ChronologicalItem[]> = {};
        const rootWorkflowChronologicalItems = this.parseTemporalHistory(historyResponse);

        for (const item of rootWorkflowChronologicalItems) {
            if (item.type === 'childWorkflow') {
                const childWorkflowId = item.workflowId;
                try {
                    const childWorkflowHistoryResponse = await this.getWorkflowData(namespace, childWorkflowId);
                    childWorkflowsMap[childWorkflowId] = this.parseTemporalHistory(childWorkflowHistoryResponse);
                } catch (error) {
                    console.error(`Failed to fetch child workflow history for ${childWorkflowId}`, error);
                    // TODO replace with node that indicates missing data?
                }

            }
        }

        return new TemporalWorkflowChronologicalItems(rootWorkflowChronologicalItems, childWorkflowsMap);
    }

    private async getWorkflowData(namespace: string, workflowId: string) {
        let baseUrl = `https://${this.endpoint}.web.tmprl.cloud/api/v1/namespaces/${namespace}/workflows/${workflowId}/history?next_page_token=`
        const headers=  {headers: {"Authorization": `Bearer ${this.apiKey}`}};

        const allEvents = [];
        let nextPageToken = null;
        do {
            // encode nextPageToken with url encoding
            let url = nextPageToken ? baseUrl + encodeURIComponent(nextPageToken) : baseUrl;
            const response = await fetch(url, headers);
            if (!response.ok) {
                throw new Error(`Failed to fetch workflow history. Status: ${response.status}`);
            }
            const data = await response.json() as HistoryResponse;
            allEvents.push(...data.history.events);
            nextPageToken = data.nextPageToken;
        } while (nextPageToken);

        return allEvents;
    }

    parseTemporalHistory(events: Event[], options?: ParseOptions): ChronologicalItem[] {
        const chronologicalList: ChronologicalItem[] = [];

        const workflowMap: Record<string, Workflow> = {};
        const activityMap: Record<string, Activity> = {};
        // We'll track the currently active workflows. The top of the stack is the one to which activities are attributed.
        const workflowStack: string[] = [];

        for (const event of events) {
            switch (event.eventType) {
                case EventType.WORKFLOW_EXECUTION_STARTED: {
                    const attrs = event.workflowExecutionStartedEventAttributes;
                    if (attrs) {
                        const wf: Workflow = {
                            type: 'workflow',
                            workflowId: attrs.workflowId,
                            runId: attrs.firstExecutionRunId,
                            workflowType: attrs.workflowType.name,
                            startTime: event.eventTime,
                            status: 'RUNNING',
                            relatedEventIds: [event.eventId],
                            payload: attrs.input?.payloads,
                        };

                        workflowMap[attrs.workflowId] = wf;
                        chronologicalList.push(wf);
                        workflowStack.push(attrs.workflowId);
                    }
                    break;
                }

                case EventType.WORKFLOW_EXECUTION_COMPLETED:
                case EventType.WORKFLOW_EXECUTION_FAILED:
                case EventType.WORKFLOW_EXECUTION_TIMED_OUT:
                case EventType.WORKFLOW_EXECUTION_CANCELED:
                case EventType.WORKFLOW_EXECUTION_TERMINATED: {
                    // These are terminal states for the currently active workflow
                    const topWorkflowId = workflowStack[workflowStack.length - 1];
                    const wf = workflowMap[topWorkflowId];
                    if (wf) {
                        wf.endTime = event.eventTime;
                        wf.relatedEventIds = wf.relatedEventIds || [];
                        wf.relatedEventIds.push(event.eventId);

                        switch (event.eventType) {
                            case EventType.WORKFLOW_EXECUTION_COMPLETED:
                                wf.status = 'COMPLETED';
                                break;
                            case EventType.WORKFLOW_EXECUTION_FAILED:
                                wf.status = 'FAILED';
                                break;
                            case EventType.WORKFLOW_EXECUTION_TIMED_OUT:
                                wf.status = 'TIMED_OUT';
                                break;
                            case EventType.WORKFLOW_EXECUTION_CANCELED:
                                wf.status = 'CANCELED';
                                break;
                            case EventType.WORKFLOW_EXECUTION_TERMINATED:
                                wf.status = 'TERMINATED';
                                break;
                        }
                    }
                    workflowStack.pop();
                    break;
                }

                case EventType.ACTIVITY_TASK_SCHEDULED: {
                    const topWorkflowId = workflowStack[workflowStack.length - 1];
                    const attrs = event.activityTaskScheduledEventAttributes;
                    if (attrs && topWorkflowId) {
                        const activityIdKey = `${topWorkflowId}:${attrs.activityId}`;
                        const act: Activity = {
                            type: 'activity',
                            activityId: attrs.activityId,
                            activityType: attrs.activityType.name,
                            workflowId: topWorkflowId,
                            scheduleTime: event.eventTime,
                            status: 'SCHEDULED',
                            relatedEventIds: [event.eventId],
                            workflowTaskCompletedEventId: attrs.workflowTaskCompletedEventId,
                        };
                        activityMap[activityIdKey] = act;
                        chronologicalList.push(act);
                    }
                    break;
                }

                case EventType.ACTIVITY_TASK_STARTED: {
                    const attrs = event.activityTaskStartedEventAttributes;
                    if (attrs) {
                        const topWorkflowId = workflowStack[workflowStack.length - 1];
                        // Find last scheduled activity without a startTime
                        for (let i = chronologicalList.length - 1; i >= 0; i--) {
                            const item = chronologicalList[i];
                            if (
                                item.type === 'activity' &&
                                item.workflowId === topWorkflowId &&
                                item.status === 'SCHEDULED'
                            ) {
                                item.startTime = event.eventTime;
                                item.status = 'STARTED';
                                item.relatedEventIds = item.relatedEventIds || [];
                                item.relatedEventIds.push(event.eventId);
                                break;
                            }
                        }
                    }
                    break;
                }

                case EventType.ACTIVITY_TASK_COMPLETED:
                case EventType.ACTIVITY_TASK_FAILED:
                case EventType.ACTIVITY_TASK_TIMED_OUT:
                case EventType.ACTIVITY_TASK_CANCELED: {
                    const topWorkflowId = workflowStack[workflowStack.length - 1];
                    let newStatus: string;
                    switch (event.eventType) {
                        case EventType.ACTIVITY_TASK_COMPLETED:
                            newStatus = 'COMPLETED';
                            break;
                        case EventType.ACTIVITY_TASK_FAILED:
                            newStatus = 'FAILED';
                            break;
                        case EventType.ACTIVITY_TASK_TIMED_OUT:
                            newStatus = 'TIMED_OUT';
                            break;
                        case EventType.ACTIVITY_TASK_CANCELED:
                            newStatus = 'CANCELED';
                            break;
                    }

                    for (let i = chronologicalList.length - 1; i >= 0; i--) {
                        const item = chronologicalList[i];
                        if (item.type === 'activity' && item.workflowId === topWorkflowId && (item.status === 'STARTED' || item.status === 'SCHEDULED')) {
                            item.endTime = event.eventTime;
                            item.status = newStatus;
                            item.relatedEventIds = item.relatedEventIds || [];
                            item.relatedEventIds.push(event.eventId);


                            if (event.eventType === EventType.ACTIVITY_TASK_COMPLETED && event.activityTaskCompletedEventAttributes?.result?.payloads) {
                                item.payload = event.activityTaskCompletedEventAttributes.result.payloads;
                            }
                            break;
                        }
                    }
                    break;
                }
                case EventType.CHILD_WORKFLOW_EXECUTION_COMPLETED: {
                    const attrs = event.childWorkflowExecutionCompletedEventAttributes;
                    if (attrs && attrs.workflowExecution) {
                        const childWfId = attrs.workflowExecution.workflowId;

                        const childWorkflow = workflowMap[childWfId];
                        if (childWorkflow) {
                            childWorkflow.endTime = event.eventTime;
                            childWorkflow.status = 'COMPLETED';
                            childWorkflow.relatedEventIds = childWorkflow.relatedEventIds || [];
                            childWorkflow.relatedEventIds.push(event.eventId);
                        }
                    }
                    break;
                }
                case EventType.CHILD_WORKFLOW_EXECUTION_STARTED: {
                    const attrs = event.childWorkflowExecutionStartedEventAttributes;
                    if (attrs && attrs.workflowExecution) {
                        const childWfId = attrs.workflowExecution.workflowId;
                        const childRunId = attrs.workflowExecution.runId;

                        if(childWfId in workflowMap){
                            // If the child workflow has already been started, update the existing entry
                            const existingChildWorkflow = workflowMap[childWfId];
                            existingChildWorkflow.startTime = event.eventTime;
                            existingChildWorkflow.relatedEventIds = existingChildWorkflow.relatedEventIds || [];
                            existingChildWorkflow.relatedEventIds.push(event.eventId);
                        }else{
                            const childWorkflow: Workflow = {
                                type: 'childWorkflow',
                                workflowId: childWfId,
                                runId: childRunId,
                                startTime: event.eventTime,
                                status: 'RUNNING',
                                parentWorkflowId: attrs.parentWorkflowExecution?.workflowId,
                                parentRunId: attrs.parentWorkflowExecution?.runId,
                                workflowType: attrs.workflowType?.name,
                                relatedEventIds: [event.eventId],
                            };

                            workflowMap[childWfId] = childWorkflow;
                            chronologicalList.push(childWorkflow);
                            workflowStack.push(childWfId);
                        }
                    }
                    break;
                }

                case EventType.START_CHILD_WORKFLOW_EXECUTION_INITIATED: {
                    const attrs = event.startChildWorkflowExecutionInitiatedEventAttributes;
                    if (attrs) {
                        if (attrs.workflowId in workflowMap) {
                            // If the child workflow has already been started, update the existing entry
                            const existingChildWorkflow = workflowMap[attrs.workflowId];
                            existingChildWorkflow.startTime = event.eventTime;
                            existingChildWorkflow.relatedEventIds = existingChildWorkflow.relatedEventIds || [];
                            existingChildWorkflow.relatedEventIds.push(event.eventId);
                            existingChildWorkflow.workflowTaskCompletedEventId = attrs.workflowTaskCompletedEventId;
                        }else{
                            const childWorkflow: Workflow = {
                                type: 'childWorkflow',
                                workflowId: attrs.workflowId,
                                startTime: event.eventTime,
                                status: 'RUNNING',
                                parentWorkflowId: attrs.workflowId,
                                // parentRunId: attrs.runId,
                                workflowType: attrs.workflowType?.name,
                                relatedEventIds: [event.eventId],
                                workflowTaskCompletedEventId: attrs.workflowTaskCompletedEventId,
                            };

                            workflowMap[attrs.workflowId] = childWorkflow;
                            chronologicalList.push(childWorkflow);
                        }
                    }
                    break;
                }

                // If you need to handle START_CHILD_WORKFLOW_EXECUTION_INITIATED or other events, add logic here
                default:
                    // Ignore other events
                    break;
            }
        }

        return chronologicalList;
    }


}


