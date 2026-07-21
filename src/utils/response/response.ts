export const successResponse = (data:any, message?:string)=>{
    return{ status: 'Success', message: message, statusCode: 200, data: data}
}

export const errorResponse = ( message?:string, statusCode?:any, data?:any,)=>{
    return{ status: 'Error', message: message, statusCode: statusCode, data: data}
}