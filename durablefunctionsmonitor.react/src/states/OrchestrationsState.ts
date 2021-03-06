import { observable, computed } from 'mobx'
import moment from 'moment';

import { DateTimeHelpers } from '../DateTimeHelpers';
import { DurableOrchestrationStatus } from '../states/DurableOrchestrationStatus';
import { ErrorMessageState } from './ErrorMessageState';
import { IBackendClient } from '../services/IBackendClient';
import { ITypedLocalStorage } from './ITypedLocalStorage';
import { CancelToken } from '../CancelToken';

export enum FilterOperatorEnum {
    Equals = 0,
    StartsWith,
    Contains
}

export enum ShowEntityTypeEnum {
    ShowBoth = 0,
    OrchestrationsOnly,
    DurableEntitiesOnly
}

// State of Orchestrations view
export class OrchestrationsState extends ErrorMessageState {

    @computed
    get hiddenColumns(): string[] { return this._hiddenColumns; }

    @computed
    get inProgress(): boolean { return this._cancelToken.inProgress && !this._cancelToken.isCancelled; }

    @computed
    get orchestrations(): DurableOrchestrationStatus[] { return this._orchestrations; }

    @computed
    get autoRefresh(): number { return this._autoRefresh; }
    set autoRefresh(val: number) {
        this._autoRefresh = val;
        this._localStorage.setItem('autoRefresh', this._autoRefresh.toString());
        this.loadOrchestrations(true);
    }

    @computed
    get timeFrom(): moment.Moment { return this._timeFrom; }
    set timeFrom(val: moment.Moment) {
        this._timeFrom = val;
        this.resetOrderBy();
    }

    @computed
    get timeTill(): moment.Moment { return (!this._timeTill) ? moment().utc() : this._timeTill; }
    set timeTill(val: moment.Moment) {
        this._timeTill = val;
        this.resetOrderBy();
    }
    
    @computed
    get timeTillEnabled(): boolean { return !!this._timeTill; }
    set timeTillEnabled(val: boolean) {

        this._timeTill = val ? moment().utc() : null;

        if (!val) {
            this.resetOrderBy();
            this.reloadOrchestrations();
        }
    }
    
    @computed
    get orderByDirection(): ('asc' | 'desc') { return this._orderByDirection;}

    @computed
    get orderBy() : string { return this._orderBy; }
    set orderBy(val: string) {

        if (this._orderBy !== val) {
            
            this._orderBy = val;
            this._orderByDirection = 'asc';

        } else if (this._orderByDirection === 'desc') {

            this.resetOrderBy();
        }
        else {
            this._orderByDirection = 'desc';
        }

        this.reloadOrchestrations();
    }

    @computed
    get filterValue(): string { return this._filterValue; }
    set filterValue(val: string) { this._filterValue = val; }

    @computed
    get filterOperator(): FilterOperatorEnum { return this._filterOperator; }
    set filterOperator(val: FilterOperatorEnum) {
        
        this._filterOperator = val;

        if (!!this._filterValue && this._filteredColumn !== '0') {

            this.reloadOrchestrations();
        }
    }

    @computed
    get filteredColumn(): string { return this._filteredColumn; }
    set filteredColumn(val: string) {

        this._filteredColumn = val;

        if (!this._filterValue) {
            return;
        }

        if (this._filteredColumn === '0') {
            this._filterValue = '';
        }

        this.reloadOrchestrations();
    }

    @computed
    get showEntityType(): string { return ShowEntityTypeEnum[this._showEntityType]; }
    set showEntityType(val: string) {

        this._showEntityType = ShowEntityTypeEnum[val];

        this.reloadOrchestrations();
    }

    @computed
    get showLastEventColumn(): boolean {
        // Only showing lastEvent field when being filtered by it (because otherwise it is not populated on the server)
        return this._filteredColumn === 'lastEvent' && (!!this._oldFilterValue);
    }

    @observable
    columnUnderMouse: string;
    
    get backendClient(): IBackendClient { return this._backendClient; }

    constructor(private _backendClient: IBackendClient, private _localStorage: ITypedLocalStorage<OrchestrationsState>) {
        super();
        
        var momentFrom: moment.Moment;
        const timeFromString = this._localStorage.getItem('timeFrom');
        if (!!timeFromString) {
            momentFrom = moment(timeFromString);
        } else {
            // By default setting it to 24 hours ago
            momentFrom = moment().subtract(1, 'days');
        }
        momentFrom.utc();

        this._timeFrom = momentFrom;
        this._oldTimeFrom = momentFrom;
       
        const timeTillString = this._localStorage.getItem('timeTill');
        if (!!timeTillString) {
            this._timeTill = moment(timeTillString);
            this._timeTill.utc();
            this._oldTimeTill = this._timeTill;
        }

        const filteredColumnString = this._localStorage.getItem('filteredColumn');
        if (!!filteredColumnString) {
            this._filteredColumn = filteredColumnString;
        }

        const filterOperatorString = this._localStorage.getItem('filterOperator');
        if (!!filterOperatorString) {
            this._filterOperator = FilterOperatorEnum[filterOperatorString];
        }

        const filterValueString = this._localStorage.getItem('filterValue');
        if (!!filterValueString) {
            this._filterValue = filterValueString;
            this._oldFilterValue = filterValueString;
        }

        const showEntityTypeString = this._localStorage.getItem('showEntityType');
        if (!!showEntityTypeString) {
            this._showEntityType = ShowEntityTypeEnum[showEntityTypeString];
        }

        const autoRefreshString = this._localStorage.getItem('autoRefresh');
        if (!!autoRefreshString) {
            this._autoRefresh = Number(autoRefreshString);
        }

        const orderByString = this._localStorage.getItem('orderBy');
        if (!!orderByString) {
            this._orderBy = orderByString;
        }

        const orderByDirectionString = this._localStorage.getItem('orderByDirection');
        if (!!orderByDirectionString) {
            this._orderByDirection = orderByDirectionString as 'asc' | 'desc';
        }

        const hiddenColumnsString = this._localStorage.getItem('hiddenColumns');
        if (!!hiddenColumnsString) {
            this._hiddenColumns = hiddenColumnsString.split('|');
        }

    }

    hideColumn(name: string) {
        this._hiddenColumns.push(name);
        this._localStorage.setItem('hiddenColumns', this._hiddenColumns.join('|'));
    }

    unhide() {
        this._hiddenColumns = [];
        this._localStorage.removeItem('hiddenColumns');
        this.reloadOrchestrations();
    }

    applyTimeFrom() {
        if (DateTimeHelpers.isValidMoment(this._timeFrom) && this._oldTimeFrom !== this._timeFrom) {
            this.reloadOrchestrations();
        }
    }

    applyTimeTill() {
        if (DateTimeHelpers.isValidMoment(this._timeTill) && this._oldTimeTill !== this._timeTill) {
            this.reloadOrchestrations();
        }
    }

    applyFilterValue() {
        if (this._oldFilterValue !== this._filterValue) {
            this.reloadOrchestrations();
        }
    }

    reloadOrchestrations() {
        this._orchestrations = [];
        this._noMorePagesToLoad = false;

        // If dates are invalid, reverting them to previous valid values
        if (!DateTimeHelpers.isValidMoment(this._timeFrom)) {
            this._timeFrom = this._oldTimeFrom;
        }
        if (!!this._timeTill && !DateTimeHelpers.isValidMoment(this._timeTill)) {
            this._timeTill = this._oldTimeTill;
        }

        // persisting state as a batch
        this._localStorage.setItems([
            { fieldName: 'timeFrom', value: this._timeFrom.toISOString() },
            { fieldName: 'timeTill', value: !!this._timeTill ? this._timeTill.toISOString() : null },
            { fieldName: 'filteredColumn', value: this._filteredColumn },
            { fieldName: 'filterOperator', value: FilterOperatorEnum[this._filterOperator] },
            { fieldName: 'filterValue', value: !!this._filterValue ? this._filterValue : null },
            { fieldName: 'showEntityType', value: ShowEntityTypeEnum[this._showEntityType] },
            { fieldName: 'orderBy', value: this._orderBy },
            { fieldName: 'orderByDirection', value: this._orderByDirection },
        ]);

        this.loadOrchestrations();

        this._oldFilterValue = this._filterValue;
        this._oldTimeFrom = this._timeFrom;
        this._oldTimeTill = this._timeTill;
    }

    cancel() {
        this._cancelToken.isCancelled = true;
        this._cancelToken = new CancelToken();
    }

    loadOrchestrations(isAutoRefresh: boolean = false) {

        const cancelToken = this._cancelToken;
        if (!!cancelToken.inProgress || (!!this._noMorePagesToLoad && !this._autoRefresh )) {
            return;            
        }
        cancelToken.inProgress = true;
        
        const timeFrom = this._timeFrom.toISOString();
        const timeTill = !!this._timeTill ? this._timeTill.toISOString() : moment().utc().toISOString();
        var filterClause = `&$filter=createdTime ge '${timeFrom}' and createdTime le '${timeTill}'`;

        if (this._showEntityType === ShowEntityTypeEnum.OrchestrationsOnly) {
            filterClause += ` and entityType eq 'Orchestration'`;
        }
        else if (this._showEntityType === ShowEntityTypeEnum.DurableEntitiesOnly) {
            filterClause += ` and entityType eq 'DurableEntity'`;
        }
        
        if (!!this._filterValue && this._filteredColumn !== '0') {

            filterClause += ' and ';

            switch (this._filterOperator) {
                case FilterOperatorEnum.Equals:
                    filterClause += `${this._filteredColumn} eq '${this._filterValue}'`;
                break;
                case FilterOperatorEnum.StartsWith:
                    filterClause += `startswith(${this._filteredColumn}, '${this._filterValue}')`;
                break;
                case FilterOperatorEnum.Contains:
                    filterClause += `contains(${this._filteredColumn}, '${this._filterValue}')`;
                break;
            }
        }

        // In auto-refresh mode only refreshing the first page
        const skip = isAutoRefresh ? 0 : this._orchestrations.length;

        const orderByClause = !!this._orderBy ? `&$orderby=${this._orderBy} ${this.orderByDirection}` : '';
        const hiddenColumnsClause = !this._hiddenColumns.length ? '' : `&hidden-columns=${this._hiddenColumns.join('|')}`; 

        const uri = `/orchestrations?$top=${this._pageSize}&$skip=${skip}${filterClause}${orderByClause}${hiddenColumnsClause}`;

        this._backendClient.call('GET', uri).then(response => {

            if (!cancelToken.isCancelled)
            {
                if (!response.length) {

                    // Stop the infinite scrolling
                    this._noMorePagesToLoad = true;

                } else {

                    if (isAutoRefresh) {
                        this._orchestrations = response;
                    } else {
                        this._orchestrations.push(...response);
                    }
                }
            }

            // Doing auto-refresh
            if (!!this._autoRefresh) {

                if (!!this._autoRefreshToken) {
                    clearTimeout(this._autoRefreshToken);
                }
                this._autoRefreshToken = setTimeout(() => this.loadOrchestrations(true), this._autoRefresh * 1000);
            }

        }, err => {

            // Cancelling auto-refresh just in case
            this._autoRefresh = 0;

            if (!cancelToken.isCancelled) {
                this.errorMessage = `Load failed: ${err.message}.${(!!err.response ? err.response.data : '')} `;
            }

        }).finally(() => {
            cancelToken.inProgress = false;
        });
    }

    @observable
    private _cancelToken: CancelToken = new CancelToken();
    @observable
    private _orchestrations: DurableOrchestrationStatus[] = [];
    @observable
    private _orderByDirection: ('asc' | 'desc') = 'asc';
    @observable
    private _orderBy: string = '';
    @observable
    private _autoRefresh: number = 0;

    @observable
    private _timeFrom: moment.Moment;
    @observable
    private _timeTill: moment.Moment;

    @observable
    private _filterValue: string = '';
    @observable
    private _filterOperator: FilterOperatorEnum = FilterOperatorEnum.Equals;
    @observable
    private _filteredColumn: string = '0';
    @observable
    private _showEntityType: ShowEntityTypeEnum = ShowEntityTypeEnum.ShowBoth;

    @observable
    private _hiddenColumns: string[] = [];

    private _noMorePagesToLoad: boolean = false;
    private readonly _pageSize = 50;
    private _autoRefreshToken: NodeJS.Timeout;
    private _oldFilterValue: string = '';

    private _oldTimeFrom: moment.Moment;
    private _oldTimeTill: moment.Moment;

    private resetOrderBy() {
        this._orderBy = '';
        this._orderByDirection = 'asc';
    }
}