import { action, Flow, wfa, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['nf_flow_demo'],
        name: 'NowFluent Flow Demo',
        description: 'now-fluent live-validate — safe to delete',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['nf_flow_demo_trigger'] },
        { table: 'incident', condition: 'short_descriptionSTARTSWITHNowFluentFlowDemo', run_flow_in: 'background' }
    ),
    (params) => {
        wfa.action(
            action.core.log,
            { $id: Now.ID['nf_flow_demo_log'] },
            { log_level: 'info', log_message: `NowFluent flow demo saw ${wfa.dataPill(params.trigger.current.number, 'string')}` }
        )
    }
)
